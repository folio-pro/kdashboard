import type { FilterState, Resource } from "$lib/types";
import { isPodNeedingAttention, matchesStatFilter } from "$lib/utils/workload-stats";
import { eventLastTimestamp, type CellContext } from "./cell-values";
import { applyFacets } from "./table-filter";

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
// than per-call localeCompare (which re-resolves the locale each time). The
// old note here favoring localeCompare benchmarked JavaScriptCore under Tauri
// and no longer applies. Timestamps (RFC 3339, uniform format) sort with plain
// string comparison — no locale semantics needed.
const collator = new Intl.Collator();

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  return items.filter((r) => {
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
  });
}

export type { FilterState };

/**
 * The one filter pipeline — stat chip, then typed facets, then free text —
 * shared by the visible list and by the saved-view counts in the toolbar, so
 * "Attention 3" and the rows you get on clicking it can never disagree.
 * `ctxFor` supplies per-resource cell context for facets on usage columns.
 */
export function applyFilterState(
  items: Resource[],
  state: FilterState,
  resourceType: string,
  ctxFor: (resource: Resource) => CellContext,
): Resource[] {
  if (state.statFilter) {
    const key = state.statFilter;
    items =
      key === "needsAttention"
        ? items.filter(isPodNeedingAttention)
        : items.filter((r) => matchesStatFilter(r, resourceType, key));
  }
  if (state.facets.length > 0) items = applyFacets(items, state.facets, ctxFor);
  if (state.text) items = filterResources(items, state.text);
  return items;
}

/** How many things the status bar should say are filtering the view. */
export function countActiveFilters(state: FilterState): number {
  return state.facets.length + (state.statFilter ? 1 : 0) + (state.text ? 1 : 0);
}

/** Sort resources by a given column and direction. */
export function sortResources(
  items: Resource[],
  sortColumn: string,
  sortDirection: SortDirection,
): Resource[] {
  return [...items].sort((a, b) => {
    let aVal: string;
    let bVal: string;

    if (sortColumn === "name") {
      aVal = a.metadata.name;
      bVal = b.metadata.name;
    } else if (sortColumn === "namespace") {
      aVal = a.metadata.namespace ?? "";
      bVal = b.metadata.namespace ?? "";
    } else if (sortColumn === "age") {
      aVal = a.metadata.creation_timestamp;
      bVal = b.metadata.creation_timestamp;
      // Note: age sort is inverted — newer (larger timestamp) first when "asc"
      return sortDirection === "asc"
        ? compareStrings(bVal, aVal)
        : compareStrings(aVal, bVal);
    } else if (sortColumn === "status") {
      aVal = (a.status?.phase as string) ?? "";
      bVal = (b.status?.phase as string) ?? "";
    } else if (sortColumn === "restarts") {
      const aCs = a.status?.containerStatuses as Array<{ restartCount: number }> | undefined;
      const bCs = b.status?.containerStatuses as Array<{ restartCount: number }> | undefined;
      const aR = aCs?.reduce((s, c) => s + (c.restartCount ?? 0), 0) ?? 0;
      const bR = bCs?.reduce((s, c) => s + (c.restartCount ?? 0), 0) ?? 0;
      return sortDirection === "asc" ? aR - bR : bR - aR;
    } else if (sortColumn === "data") {
      const aData = a.data ?? a.spec?.data ?? a.status?.data;
      const bData = b.data ?? b.spec?.data ?? b.status?.data;
      const aCount = aData && typeof aData === "object" ? Object.keys(aData).length : 0;
      const bCount = bData && typeof bData === "object" ? Object.keys(bData).length : 0;
      return sortDirection === "asc" ? aCount - bCount : bCount - aCount;
    } else if (sortColumn === "type" || sortColumn === "eventType") {
      aVal = (a.spec?.type as string) ?? a.type ?? "";
      bVal = (b.spec?.type as string) ?? b.type ?? "";
    } else if (sortColumn === "eventLastSeen") {
      // Parsed, not string-compared: eventTime is a MicroTime, and RFC 3339
      // strings with and without fractional seconds do not sort lexically.
      const aTime = Date.parse(eventLastTimestamp(a) ?? a.metadata.creation_timestamp);
      const bTime = Date.parse(eventLastTimestamp(b) ?? b.metadata.creation_timestamp);
      // Like age: newest first when "asc", so the default view leads with
      // what the cluster did most recently.
      return sortDirection === "asc" ? bTime - aTime : aTime - bTime;
    } else if (sortColumn === "eventReason") {
      aVal = (a.spec?.reason as string) ?? "";
      bVal = (b.spec?.reason as string) ?? "";
    } else {
      aVal = a.metadata.name;
      bVal = b.metadata.name;
    }

    const cmp = collator.compare(aVal, bVal);
    return sortDirection === "asc" ? cmp : -cmp;
  });
}

/** Returns true when every filtered resource is in the selected set. */
export function computeAllSelected(filteredResources: Resource[], selectedRows: Set<string>): boolean {
  return (
    filteredResources.length > 0 &&
    filteredResources.every((r) => selectedRows.has(r.metadata.uid))
  );
}

/** Returns true when at least one filtered resource is in the selected set. */
export function computeSomeSelected(filteredResources: Resource[], selectedRows: Set<string>): boolean {
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

