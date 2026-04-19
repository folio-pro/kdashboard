import type { Resource } from "$lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_COL_WIDTH = 40;

// ---------------------------------------------------------------------------
// Pure functions extracted from ResourceTable.svelte
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc";

/** Clamp a column width to the minimum allowed value. */
export function clampColumnWidth(width: number): number {
  return Math.max(MIN_COL_WIDTH, width);
}

/** Text filtering — matches resource name or namespace case-insensitively. */
export function filterResources(items: Resource[], filterText: string): Resource[] {
  if (!filterText) return items;
  const lower = filterText.toLowerCase();
  return items.filter(
    (r) =>
      r.metadata.name.toLowerCase().includes(lower) ||
      (r.metadata.namespace ?? "").toLowerCase().includes(lower),
  );
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
    } else if (sortColumn === "type") {
      aVal = (a.spec?.type as string) ?? a.type ?? "";
      bVal = (b.spec?.type as string) ?? b.type ?? "";
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

/** Format copy-feedback text, truncating long values at 40 chars. */
export function formatCopyFeedback(value: string): string {
  return `Copied: ${value.length > 40 ? value.slice(0, 40) + "..." : value}`;
}
