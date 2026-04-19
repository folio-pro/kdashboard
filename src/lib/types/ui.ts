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

// Timeline Types

export interface TimelineEntry {
  timestamp: string;
  type: "event" | "condition" | "status";
  severity: "normal" | "warning" | "error";
  title: string;
  detail: string;
}
