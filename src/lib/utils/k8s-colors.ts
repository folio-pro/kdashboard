/** Kind → color mapping for topology and other visualizations */
export const KIND_COLORS: Record<string, string> = {
  Pod: "#4285F4",
  Deployment: "#34A853",
  ReplicaSet: "#7CB342",
  StatefulSet: "#00897B",
  DaemonSet: "#5E35B1",
  Job: "#FB8C00",
  CronJob: "#F4511E",
  Service: "#E91E63",
  Ingress: "#9C27B0",
  ConfigMap: "#00ACC1",
  Secret: "#FF7043",
  HorizontalPodAutoscaler: "#6D4C41",
  Node: "#546E7A",
  Namespace: "#78909C",
};

/** Short display labels for K8s kinds */
export const KIND_SHORT: Record<string, string> = {
  Deployment: "Deploy",
  ReplicaSet: "RS",
  StatefulSet: "STS",
  DaemonSet: "DS",
  ConfigMap: "CM",
  HorizontalPodAutoscaler: "HPA",
  CronJob: "CronJob",
};

/** Status → CSS color variable mapping for K8s resource statuses */
export const STATUS_COLORS: Record<string, string> = {
  Running: "var(--status-running)",
  Available: "var(--status-running)",
  Active: "var(--status-running)",
  Bound: "var(--status-running)",
  Complete: "var(--status-succeeded)",
  Succeeded: "var(--status-succeeded)",
  Pending: "var(--status-pending)",
  Failed: "var(--status-failed)",
  Unavailable: "var(--status-failed)",
  Unknown: "var(--text-muted)",
};

export const DEFAULT_KIND_COLOR = "#78909C";
