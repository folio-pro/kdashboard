export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export type SortDirection = "asc" | "desc";

export interface CommandPaletteItem {
  id: string;
  label: string;
  description?: string;
  category: string;
  hint?: string;
  // Icon is typed loosely to accommodate lucide-svelte components.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: any;
  action: () => void;
}

export interface PortForwardInfo {
  session_id: string;
  pod_name: string;
  namespace: string;
  container_port: number;
  local_port: number;
}


/** Row height presets for resource tables, in toggle order. */
export const TABLE_DENSITIES = ["comfortable", "compact", "terminal"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];
export function isTableDensity(value: unknown): value is TableDensity {
  return (TABLE_DENSITIES as readonly unknown[]).includes(value);
}

/** Comparison a typed filter term applies to a cell. */
export type FacetOp = ":" | "!:" | ">" | "<" | ">=" | "<=";

/**
 * One typed filter term (`status:!running`, `restarts:>0`), lifted out of the
 * search text and shown as a chip. `key` is a resolved column key.
 */
export interface Facet {
  key: string;
  op: FacetOp;
  value: string;
}

/** Everything a table tab filters on: stat chip, typed terms, free text. */
export interface FilterState {
  facets: Facet[];
  text: string;
  statFilter: string | null;
}

/** A named filter set for one resource type's table. */
export interface SavedView {
  id: string;
  name: string;
  resourceType: string;
  facets: Facet[];
  text?: string;
  statFilter?: string | null;
  /** Ships with the app; cannot be deleted. */
  builtin?: boolean;
}
