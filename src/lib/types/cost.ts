// Cost Types

export interface ResourceCost {
  name: string;
  namespace: string;
  kind: string;
  cpu_cores: number;
  memory_bytes: number;
  cpu_cost_hourly: number;
  memory_cost_hourly: number;
  total_cost_hourly: number;
  total_cost_monthly: number;
}

export interface NamespaceCostSummary {
  namespace: string;
  total_cpu_cores: number;
  total_memory_gb: number;
  total_cost_hourly: number;
  total_cost_monthly: number;
  workload_count: number;
  workloads: ResourceCost[];
}

export interface CostOverview {
  namespaces: NamespaceCostSummary[];
  cluster_cost_hourly: number;
  cluster_cost_monthly: number;
  total_cpu_cores: number;
  total_memory_gb: number;
  cpu_rate_per_core_hour: number;
  memory_rate_per_gb_hour: number;
  source: string;
  fetched_at: string;
}

export interface NodeCostInfo {
  node_name: string;
  instance_type: string;
  provider: string;
  region: string;
  price_per_hour: number;
  price_per_month: number;
}

export interface NodeMetricsInfo {
  node_name: string;
  cpu_usage: number;
  cpu_capacity: number;
  cpu_percent: number;
  memory_usage: number;
  memory_capacity: number;
  memory_percent: number;
}
