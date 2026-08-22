// Cluster overview wire types — mirror electron/k8s/overview.ts (snake_case).

export interface NodeSummary {
  name: string;
  ready: boolean;
  pressure: string[];
  unschedulable: boolean;
  instance_type: string | null;
  zone: string | null;
  kubelet_version: string | null;
  cpu_allocatable: number;
  memory_allocatable: number;
  cpu_requests: number | null;
  memory_requests: number | null;
  pod_count: number | null;
  cpu_usage: number | null;
  memory_usage: number | null;
  age: string | null;
}

export interface PodPhaseCounts {
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  unknown: number;
  total: number;
}

export type ProblemSeverity = "critical" | "warning";
export type ProblemKind = "Pod" | "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "Node";

export interface Problem {
  id: string;
  severity: ProblemSeverity;
  kind: ProblemKind;
  name: string;
  namespace: string | null;
  reason: string;
  detail: string | null;
  owner: string | null;
  since: string | null;
  restarts: number;
  ready: number | null;
  desired: number | null;
}

export interface WarningEvent {
  reason: string;
  message: string;
  kind: string;
  name: string;
  namespace: string | null;
  count: number;
  last_timestamp: string | null;
}

export interface TopPod {
  name: string;
  namespace: string;
  cpu_usage: number;
  memory_usage: number;
}

export interface ClusterOverview {
  scope: "cluster" | "namespace";
  namespace: string | null;
  nodes: NodeSummary[];
  pods: PodPhaseCounts;
  problems: Problem[];
  warnings: WarningEvent[];
  warnings_total: number;
  top_pods_cpu: TopPod[];
  top_pods_memory: TopPod[];
  metrics_available: boolean;
  partial: string[];
  fetched_at: string;
}
