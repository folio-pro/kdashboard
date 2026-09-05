// Rightsizing wire types — mirror electron/k8s/rightsizing.ts (snake_case).

export type RightsizingVerdict = "over" | "under" | "ok" | "no-request" | "no-data";

export interface ContainerRightsizing {
  container: string;
  cpu_request: number | null;
  memory_request: number | null;
  cpu_limit: number | null;
  memory_limit: number | null;
  cpu_usage: number | null;
  memory_usage: number | null;
  cpu_recommended: number | null;
  memory_recommended: number | null;
  cpu_verdict: RightsizingVerdict;
  memory_verdict: RightsizingVerdict;
}

export interface WorkloadRightsizing {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  replicas: number;
  containers: ContainerRightsizing[];
  verdict: RightsizingVerdict;
  saving_monthly: number;
  cpu_delta: number;
  memory_delta: number;
}

export interface RightsizingOverview {
  scope: "cluster" | "namespace";
  namespace: string | null;
  workloads: WorkloadRightsizing[];
  usage_source: string;
  usage_window: string;
  cpu_rate_per_core_hour: number;
  memory_rate_per_gb_hour: number;
  total_saving_monthly: number;
  over_count: number;
  under_count: number;
  fetched_at: string;
}
