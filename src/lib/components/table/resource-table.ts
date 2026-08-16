import type { Resource } from "$lib/types";
import { eventLastTimestamp } from "./cell-values";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_COL_WIDTH = 40;

// ---------------------------------------------------------------------------
// Pure functions extracted from ResourceTable.svelte
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc";

// NOTE: we use String.prototype.localeCompare directly here, NOT a cached
// Intl.Collator. A micro-benchmark on 3000 names showed the cached collator is
// ~1.5-2x SLOWER than localeCompare in JavaScriptCore (the Tauri webview engine
// on macOS/Linux) and also changes ordering semantics — so the "cache a
// collator" optimization is a regression for this runtime. See the perf audit.

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
        ? bVal.localeCompare(aVal)
        : aVal.localeCompare(bVal);
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

    const cmp = aVal.localeCompare(bVal);
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

