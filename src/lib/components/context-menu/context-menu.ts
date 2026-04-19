/**
 * Pure logic for ContextMenu — no Svelte runtime, no $state/$derived.
 *
 * Functions extracted from ContextMenu.svelte so they can be unit-tested
 * without mounting a component.
 */

import type { ActionDef } from "$lib/actions/types";

// ---------------------------------------------------------------------------
// Menu height estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the pixel height of the context menu.
 *
 *   items × 34px  +  group separators × 8px  +  48px base padding
 */
export function estimateMenuHeight(
  itemCount: number,
  groupCount: number,
): number {
  return itemCount * 34 + groupCount * 8 + 48;
}

// ---------------------------------------------------------------------------
// Menu positioning
// ---------------------------------------------------------------------------

const MENU_WIDTH = 220;
const EDGE_PADDING = 8;

/**
 * Clamp the menu position so it stays within the viewport.
 */
export function calculateMenuPosition(
  x: number,
  y: number,
  itemCount: number,
  groupCount: number,
  viewportW: number,
  viewportH: number,
  _isBulk: boolean,
): { x: number; y: number } {
  const menuH = estimateMenuHeight(itemCount, groupCount);

  if (x + MENU_WIDTH > viewportW - EDGE_PADDING)
    x = viewportW - MENU_WIDTH - EDGE_PADDING;
  if (y + menuH > viewportH - EDGE_PADDING)
    y = viewportH - menuH - EDGE_PADDING;
  if (x < EDGE_PADDING) x = EDGE_PADDING;
  if (y < EDGE_PADDING) y = EDGE_PADDING;

  return { x, y };
}

// ---------------------------------------------------------------------------
// Action enabled check
// ---------------------------------------------------------------------------

/**
 * Determine whether `action` is enabled for the given `resource`.
 *
 * - If the action has no `enabled` guard, it is always enabled.
 * - If `resource` is null/undefined, the action is treated as enabled (bulk
 *   mode or menu not yet bound to a resource).
 */
export function isActionEnabled(
  action: Pick<ActionDef, "enabled">,
  resource: unknown | null,
): boolean {
  if (!action.enabled) return true;
  return resource ? action.enabled(resource as any) : true;
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

/**
 * Find the next enabled item index in `direction` (+1 or -1).
 *
 * In bulk mode every item is considered enabled (the `enabled` guard is
 * skipped), so we simply bounds-check.
 */
export function findNextEnabled(
  from: number,
  direction: 1 | -1,
  flatItems: Array<Pick<ActionDef, "enabled">>,
  isBulk: boolean,
  resource: unknown | null,
): number {
  if (isBulk) {
    const next = from + direction;
    if (next < 0 || next >= flatItems.length) return from;
    return next;
  }

  let idx = from + direction;
  while (idx >= 0 && idx < flatItems.length) {
    if (isActionEnabled(flatItems[idx], resource)) return idx;
    idx += direction;
  }
  return from; // stay in place if no enabled item found
}

// ---------------------------------------------------------------------------
// Tier → CSS color mapping
// ---------------------------------------------------------------------------

/**
 * Map a safety tier string to the corresponding CSS custom-property value.
 */
export function tierColor(tier: string): string {
  switch (tier) {
    case "red":
      return "var(--status-failed)";
    case "yellow":
      return "var(--status-warning)";
    default:
      return "var(--text-secondary)";
  }
}
