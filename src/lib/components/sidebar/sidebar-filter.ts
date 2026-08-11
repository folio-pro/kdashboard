import type { CrdInfo } from "$lib/types/index.js";

/**
 * Nav filtering, kept out of the component for the same reason
 * `table/resource-table.ts` is: it is pure list-shaping logic with edge cases
 * worth asserting, and a `.svelte` file is not reachable from `bun test`.
 */

/** The shape both fixed sections and discovered CRD groups reduce to. */
export interface FilterableGroup<T> {
  /** Group heading — a match here keeps every child. */
  title: string;
  items: T[];
}

/**
 * Keep groups whose title matches (with all their children) or that still
 * have matching children. Empty groups drop out.
 *
 * An empty query returns the input untouched, so callers can filter
 * unconditionally rather than branching on "is the filter active".
 */
export function filterGroups<T>(
  groups: FilterableGroup<T>[],
  query: string,
  matches: (item: T, query: string) => boolean,
): FilterableGroup<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;

  return groups
    .map((group) => ({
      ...group,
      items: group.title.toLowerCase().includes(q)
        ? group.items
        : group.items.filter((item) => matches(item, q)),
    }))
    .filter((group) => group.items.length > 0);
}

/** A catalog entry matches on its display name or its kubectl short name. */
export function resourceMatches(
  item: { name: string; short?: string },
  query: string,
): boolean {
  return (
    item.name.toLowerCase().includes(query) ||
    (item.short?.toLowerCase().includes(query) ?? false)
  );
}

/** A CRD matches on its kind or its first short name. */
export function crdMatches(crd: CrdInfo, query: string): boolean {
  return resourceMatches({ name: crd.kind, short: crd.short_names[0] }, query);
}
