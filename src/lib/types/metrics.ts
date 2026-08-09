// Wire shapes for the metrics handlers (electron/handlers/metrics.ts).

export interface ContainerUsage {
  name: string;
  cpu_cores: number;
  memory_bytes: number;
}

export interface PodUsageInfo {
  name: string;
  namespace: string;
  cpu_cores: number;
  memory_bytes: number;
  containers: ContainerUsage[];
}

export interface PodMetricsResult {
  available: boolean;
  reason: string;
  pods: PodUsageInfo[];
}

export interface PrometheusSample {
  /** Unix seconds. */
  t: number;
  v: number;
}

export interface PrometheusSeries {
  labels: Record<string, string>;
  samples: PrometheusSample[];
}

export interface PrometheusResult {
  configured: boolean;
  series: PrometheusSeries[];
}
