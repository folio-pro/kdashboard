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
  /** Set when this session was started from a saved forward. */
  saved_id?: string;
}

/** Kinds a saved forward can point at. Anything but Pod is resolved to one of
 *  its running pods each time the forward starts, so it survives restarts. */
export type ForwardTargetKind = "Pod" | "Service" | "Deployment" | "StatefulSet" | "DaemonSet";

/**
 * A port forward the user asked to keep: re-creatable on demand, optionally
 * started when its context connects, reconnected when the pod behind it goes
 * away. Persisted in settings (`saved_port_forwards`), snake_case like the
 * rest of the settings file.
 */
export interface SavedPortForward {
  id: string;
  context: string;
  namespace: string;
  target_kind: ForwardTargetKind;
  target_name: string;
  /** Port on the pod (or, for a Service, the service port). */
  container_port: number;
  local_port: number;
  /** Start automatically when the context connects. */
  auto_start: boolean;
}


/**
 * A resource the user asked to be alerted about: polled while its context is
 * connected; a health change or a new Warning event raises a desktop
 * notification. Persisted in settings (`watched_resources`).
 */
export interface WatchedResource {
  id: string;
  context: string;
  kind: string;
  /** Plural resource_type, for get_resource_events and navigation. */
  resourceType: string;
  name: string;
  namespace?: string;
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
