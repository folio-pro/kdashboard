import type { FilterState, Resource } from "$lib/types";
import { isPodNeedingAttention, matchesStatFilter } from "$lib/utils/workload-stats";
import { eventLastTimestamp, getCellValue, type CellContext } from "./cell-values";
import { matchesFacet } from "./table-filter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_COL_WIDTH = 40;

// ---------------------------------------------------------------------------
// Pure functions extracted from ResourceTable.svelte
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc";

// Cached collator: the sort re-runs over the full list on every watch flush,
// and in V8 (Electron) a cached Intl.Collator.compare is several times faster
// than per-call localeCompare (which re-resolves the locale each time).
const collator = new Intl.Collator();

/** Clamp a column width to the minimum allowed value. */
export function clampColumnWidth(width: number): number {
  return Math.max(MIN_COL_WIDTH, width);
}

/**
 * Text filtering — matches resource name or namespace case-insensitively.
 * Events additionally match on reason/message: their names are hashes the
 * table does not even show, so name-only filtering would find nothing.
 */
export function filterResources(items: Resource[], filterText: string): Resource[] {
  if (!filterText) return items;
  const lower = filterText.toLowerCase();
  return items.filter((r) => matchesText(r, lower));
}

/** `lower` must already be lowercased — callers hoist that out of the loop. */
export function matchesText(r: Resource, lower: string): boolean {
  if (
    r.metadata.name.toLowerCase().includes(lower) ||
    (r.metadata.namespace ?? "").toLowerCase().includes(lower)
  ) {
    return true;
  }
  if (r.kind !== "Event") return false;
  const spec = r.spec as { reason?: unknown; message?: unknown } | undefined;
  return (
    (typeof spec?.reason === "string" && spec.reason.toLowerCase().includes(lower)) ||
    (typeof spec?.message === "string" && spec.message.toLowerCase().includes(lower))
  );
}

export type { FilterState };

/**
 * The one filter pipeline — stat chip, then typed facets, then free text —
 * shared by the visible list and by the saved-view counts in the toolbar, so
 * "Attention 3" and the rows you get on clicking it can never disagree.
 * `ctxFor` supplies per-resource cell context for facets on usage columns.
 * Returns null when the state filters nothing, so callers can skip the pass.
 */
export function compileFilterState(
  state: FilterState,
  resourceType: string,
  ctxFor: (resource: Resource) => CellContext,
): ((resource: Resource) => boolean) | null {
  const tests: Array<(r: Resource) => boolean> = [];
  if (state.statFilter) {
    const key = state.statFilter;
    tests.push(
      key === "needsAttention"
        ? isPodNeedingAttention
        : (r) => matchesStatFilter(r, resourceType, key),
    );
  }
  if (state.facets.length > 0) {
    const facets = state.facets;
    tests.push((r) => {
      const ctx = ctxFor(r);
      return facets.every((f) => matchesFacet(r, f, ctx));
    });
  }
  if (state.text) {
    const lower = state.text.toLowerCase();
    tests.push((r) => matchesText(r, lower));
  }
  if (tests.length === 0) return null;
  if (tests.length === 1) return tests[0];
  return (r) => tests.every((t) => t(r));
}

export function applyFilterState(
  items: Resource[],
  state: FilterState,
  resourceType: string,
  ctxFor: (resource: Resource) => CellContext,
): Resource[] {
  const test = compileFilterState(state, resourceType, ctxFor);
  return test ? items.filter(test) : items;
}

/**
 * Row count per saved view in ONE pass over the items. The toolbar needs a
 * number per view on every watch flush; filtering the list once per view
 * materialized K arrays and built a cell context per row per facet view.
 * Here the context is built at most once per row and shared by every view.
 */
export function countViews(
  items: Resource[],
  views: Array<{ id: string; state: FilterState }>,
  resourceType: string,
  ctxFor: (resource: Resource) => CellContext,
): Record<string, number> {
  const out: Record<string, number> = {};
  let current: Resource | null = null;
  let currentCtx: CellContext | undefined;
  const sharedCtx = (r: Resource) => {
    if (r !== current) {
      current = r;
      currentCtx = ctxFor(r);
    }
    return currentCtx!;
  };
  const active: Array<{ id: string; test: (r: Resource) => boolean }> = [];
  for (const view of views) {
    const test = compileFilterState(view.state, resourceType, sharedCtx);
    if (test) {
      out[view.id] = 0;
      active.push({ id: view.id, test });
    } else {
      out[view.id] = items.length;
    }
  }
  if (active.length === 0) return out;
  for (const r of items) {
    for (const view of active) {
      if (view.test(r)) out[view.id]++;
    }
  }
  return out;
}

/** How many things the status bar should say are filtering the view. */
export function countActiveFilters(state: FilterState): number {
  return state.facets.length + (state.statFilter ? 1 : 0) + (state.text ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * How a column's sort key is derived. Every key except name/namespace/time
 * starts from what the cell displays (getCellValue), so a column cannot
 * quietly sort by something else; the kind only says how to read that text.
 *
 * - `text`: the cell text, collated; "-" (no value) sorts as empty.
 * - `number`: the cell's number ("14", "-5"); no value sorts lowest.
 * - `fraction`: a "ready/total" cell, by ratio — least ready first on asc.
 * - `time`: a timestamp, newest first on asc (age, last seen).
 */
type SortKind = "text" | "number" | "fraction" | "time";

const SORT_KINDS = new Map<string, SortKind>([
  ["name", "text"],
  ["namespace", "text"],
  ["age", "time"],
  ["status", "text"],
  ["phase", "text"],
  ["type", "text"],
  ["data", "number"],
  // Pods
  ["podReady", "fraction"],
  ["restarts", "number"],
  ["controlledBy", "text"],
  ["node", "text"],
  // Deployments
  ["deployReady", "fraction"],
  ["deployStatus", "text"],
  ["pods", "number"],
  // Services / ingresses / scheduling
  ["endpoints", "fraction"],
  ["ingressClass", "text"],
  ["pcValue", "number"],
  // Events
  ["eventLastSeen", "time"],
  ["eventType", "text"],
  ["eventReason", "text"],
]);

/** Columns whose cell reads the per-row CellContext (store data). */
const CONTEXT_COLUMNS = new Set(["endpoints"]);

/** Whether `column` has a sort key; a column without one leaves rows in name order. */
export function hasSortKey(column: string): boolean {
  return SORT_KINDS.has(column);
}

const NO_CONTEXT: CellContext = { ageTick: 0 };

type SortKey = string | number;

function timeKey(r: Resource, column: string): number {
  // Parsed, not string-compared: an event's eventTime is a MicroTime, and
  // RFC 3339 strings with and without fractional seconds do not sort lexically.
  const ts = column === "eventLastSeen"
    ? eventLastTimestamp(r) ?? r.metadata.creation_timestamp
    : r.metadata.creation_timestamp;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? -Infinity : t;
}

/** "2/3" → 0.667; "0/0" → 0 (nothing ready); "-" or "" (unknown) → lowest. */
function fractionKey(value: string): number {
  const slash = value.indexOf("/");
  if (slash < 0) return -Infinity;
  const ready = Number(value.slice(0, slash));
  const total = Number(value.slice(slash + 1));
  if (Number.isNaN(ready) || Number.isNaN(total)) return -Infinity;
  return total > 0 ? ready / total : 0;
}

function numberKey(value: string): number {
  const n = Number(value);
  return value === "" || Number.isNaN(n) ? -Infinity : n;
}

/** The value `column` sorts `r` by. Unknown columns all tie, leaving the name tie-break. */
function sortKeyFor(r: Resource, column: string, kind: SortKind | undefined, ctx: CellContext): SortKey {
  if (kind === "time") return timeKey(r, column);
  if (column === "name") return r.metadata.name;
  if (column === "namespace") return r.metadata.namespace ?? "";
  if (!kind) return "";
  const value = getCellValue(r, column, ctx);
  if (kind === "number") return numberKey(value);
  if (kind === "fraction") return fractionKey(value);
  return value === "-" ? "" : value;
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  return collator.compare(a as string, b as string);
}

/**
 * Sort resources by a given column and direction. Decorate-sort-undecorate:
 * the list is re-sorted on every watch flush, so each row's key is computed
 * once rather than on every comparison. Equal keys break by name ascending in
 * both directions, so flipping the direction does not shuffle ties.
 * `ctxFor` supplies the cell context for columns that read store data
 * (Endpoints); it is not called for any other column, so the sort does not
 * subscribe to stores it does not need.
 */
export function sortResources(
  items: Resource[],
  sortColumn: string,
  sortDirection: SortDirection,
  ctxFor?: (resource: Resource) => CellContext,
): Resource[] {
  const kind = SORT_KINDS.get(sortColumn);
  const readCtx = ctxFor && CONTEXT_COLUMNS.has(sortColumn) ? ctxFor : null;
  // Age and last-seen are inverted: newest (larger timestamp) first on "asc".
  const sign = (sortDirection === "asc") !== (kind === "time") ? 1 : -1;

  const rows = items.map((r) => ({
    r,
    key: sortKeyFor(r, sortColumn, kind, readCtx ? readCtx(r) : NO_CONTEXT),
  }));
  rows.sort((a, b) =>
    sign * compareKeys(a.key, b.key) || collator.compare(a.r.metadata.name, b.r.metadata.name),
  );
  return rows.map((row) => row.r);
}

/** Returns true when every filtered resource is in the selected set. */
export function computeAllSelected(filteredResources: Resource[], selectedRows: Set<string>): boolean {
  return (
    filteredResources.length > 0 &&
    selectedRows.size >= filteredResources.length &&
    filteredResources.every((r) => selectedRows.has(r.metadata.uid))
  );
}

/** Returns true when at least one filtered resource is in the selected set. */
export function computeSomeSelected(filteredResources: Resource[], selectedRows: Set<string>): boolean {
  if (selectedRows.size === 0) return false;
  return filteredResources.some((r) => selectedRows.has(r.metadata.uid));
}

/**
 * Compute the new selection set after a "select all" toggle.
 * Returns an empty set when all are already selected, otherwise
 * returns a set containing every filtered resource's uid.
 */
export function handleSelectAll(
  allSelected: boolean,
  filteredResources: Resource[],
): Set<string> {
  if (allSelected) {
    return new Set();
  } else {
    return new Set(filteredResources.map((r) => r.metadata.uid));
  }
}

