import { TABLE_DENSITIES, type TableDensity } from "$lib/types";

/**
 * Row heights per density. The virtualizer's estimateSize and the row's own
 * height read from here, so the estimate is exact for every preset.
 *
 *   comfortable  36px  default — a 12px line with room to scan
 *   compact      30px  the same cells, tighter
 *   terminal     26px  mono 11px, for operators who live in k9s
 */
export const ROW_HEIGHT: Record<TableDensity, number> = {
  comfortable: 36,
  compact: 30,
  terminal: 26,
};

export const DENSITY_ORDER: readonly TableDensity[] = TABLE_DENSITIES;

export const DENSITY_LABEL: Record<TableDensity, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
  terminal: "Terminal",
};

/**
 * What a row paints per density, besides its height: type size and mono face.
 * Tailwind scans this file, so the class strings must stay literal.
 */
export const DENSITY_CLASSES: Record<TableDensity, { text: string; mono: boolean }> = {
  comfortable: { text: "text-[12px]", mono: false },
  compact: { text: "text-[12px]", mono: false },
  terminal: { text: "text-[11px]", mono: true },
};

/** The next preset in the cycle — what the context menu's toggle steps through. */
export function nextDensity(current: TableDensity): TableDensity {
  const i = DENSITY_ORDER.indexOf(current);
  return DENSITY_ORDER[(i + 1) % DENSITY_ORDER.length];
}
