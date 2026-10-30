import type { ActiveView } from "./stores/ui.logic.js";

export type ShortcutScope = "global" | "table" | "details";

/**
 * The shortcut scope a view answers to, besides "global". A CRD list is a
 * table like any other, so `/` (filter) and `r` (refresh) — and the j/k/Enter
 * hints its own handler implements — apply there too.
 */
export function scopeOfView(view: ActiveView): ShortcutScope | null {
  if (view === "table" || view === "crd-table") return "table";
  if (view === "details") return "details";
  return null;
}
