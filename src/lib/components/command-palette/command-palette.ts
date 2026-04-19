import type { CommandPaletteItem } from "$lib/types";

/** The canonical category rendering order for core groups. Extension
 * categories appear after this list in the order they are first seen. */
export const CATEGORY_ORDER = [
  "Resource Actions",
  "Resources",
  "Custom Resources",
  "Contexts",
  "Namespaces",
  "Actions",
];

/** Split query into lowercase tokens, dropping empty strings. */
export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Does a single item match ALL tokens against its label+description+category? */
export function matchItem(item: CommandPaletteItem, tokens: string[]): boolean {
  const haystack = `${item.label} ${item.description ?? ""} ${item.category}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Filter items: empty/blank query returns all; otherwise token-based AND match. */
export function filterCommandItems(
  items: CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  if (!query) return items;
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return items;
  return items.filter((item) => matchItem(item, tokens));
}

/** Group items by their category field. */
export function groupByCategory(
  items: CommandPaletteItem[],
): Record<string, CommandPaletteItem[]> {
  const groups: Record<string, CommandPaletteItem[]> = {};
  for (const item of items) {
    if (!groups[item.category]) {
      groups[item.category] = [];
    }
    groups[item.category].push(item);
  }
  return groups;
}

/**
 * Return groups in stable order: known categories first (per CATEGORY_ORDER),
 * then any remaining unknown categories in Object.entries order.
 */
export function orderGroups(
  grouped: Record<string, CommandPaletteItem[]>,
  categoryOrder: string[] = CATEGORY_ORDER,
): [string, CommandPaletteItem[]][] {
  const entries: [string, CommandPaletteItem[]][] = [];
  for (const cat of categoryOrder) {
    if (grouped[cat]) {
      entries.push([cat, grouped[cat]]);
    }
  }
  for (const [cat, items] of Object.entries(grouped)) {
    if (!categoryOrder.includes(cat)) {
      entries.push([cat, items]);
    }
  }
  return entries;
}

/**
 * Navigate selection index with clamping.
 * direction: +1 for down, -1 for up.
 */
export function navigateSelection(
  current: number,
  direction: number,
  totalItems: number,
): number {
  if (direction > 0) {
    return Math.min(current + 1, totalItems - 1);
  }
  return Math.max(current - 1, 0);
}
