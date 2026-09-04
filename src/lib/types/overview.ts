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
export type ProblemKind = "Pod" | "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "Node" | "PersistentVolumeClaim" | "Service";

/** Machine-readable category the Problems view keys its actions on (mirror of electron/k8s/pod-cause.ts). */
export type ProblemCause =
  | "image-pull"
  | "config"
  | "crash"
  | "oom"
  | "unschedulable"
  | "progress-deadline"
  | "job-failed"
  | "pvc-pending"
  | "no-endpoints"
  | "lb-pending"
  | "unknown";

/** The most relevant pod behind a problem — where "Open pod" / "View pod logs" land. */
export interface PodRef {
  name: string;
  namespace: string;
  container: string | null;
}

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
  cause: ProblemCause;
  pod: PodRef | null;
}

/**
 * What diagnose_resource adds on top of the generic DiagnosticResult
 * (src/lib/types/cluster.ts): the cause and pod it settled on after looking
 * at the owned pods, which can be more precise than the overview's snapshot.
 */
export interface DiagnosisVerdict {
  cause: ProblemCause;
  pod: PodRef | null;
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
