use serde::{Deserialize, Serialize};
use std::time::Instant;

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceCost {
    pub name: String,
    pub namespace: String,
    pub kind: String,
    pub cpu_cores: f64,
    pub memory_bytes: f64,
    pub cpu_cost_hourly: f64,
    pub memory_cost_hourly: f64,
    pub total_cost_hourly: f64,
    pub total_cost_monthly: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamespaceCostSummary {
    pub namespace: String,
    pub total_cpu_cores: f64,
    pub total_memory_gb: f64,
    pub total_cost_hourly: f64,
    pub total_cost_monthly: f64,
    pub workload_count: u32,
    pub workloads: Vec<ResourceCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostOverview {
    pub namespaces: Vec<NamespaceCostSummary>,
    pub cluster_cost_hourly: f64,
    pub cluster_cost_monthly: f64,
    pub total_cpu_cores: f64,
    pub total_memory_gb: f64,
    pub cpu_rate_per_core_hour: f64,
    pub memory_rate_per_gb_hour: f64,
    pub source: String, // "cloud-pricing" | "fallback" | "requests"
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMetricsInfo {
    pub node_name: String,
    pub cpu_usage: f64,       // cores
    pub cpu_capacity: f64,    // cores
    pub cpu_percent: f64,     // 0-100
    pub memory_usage: f64,    // bytes
    pub memory_capacity: f64, // bytes
    pub memory_percent: f64,  // 0-100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCostInfo {
    pub node_name: String,
    pub instance_type: String,
    pub provider: String,
    pub region: String,
    pub price_per_hour: f64,
    pub price_per_month: f64,
}

// ---------------------------------------------------------------------------
// Internal data types (pub(super) so sibling modules can use them)
// ---------------------------------------------------------------------------

pub(super) struct CostCache {
    pub data: Option<CostOverview>,
    pub expires_at: Instant,
}

// Pod / node metrics types used by the metrics-server integration

#[derive(Debug, Deserialize)]
pub(super) struct PodMetricsList {
    pub items: Vec<PodMetrics>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PodMetrics {
    pub metadata: PodMetricsMetadata,
    pub containers: Vec<ContainerMetrics>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PodMetricsMetadata {
    pub name: String,
    pub namespace: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContainerMetrics {
    pub usage: ResourceUsage,
}

#[derive(Debug, Deserialize)]
pub(super) struct ResourceUsage {
    pub cpu: String,
    pub memory: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct NodeMetricsList {
    pub items: Vec<NodeMetricsItem>,
}

#[derive(Debug, Deserialize)]
pub(super) struct NodeMetricsItem {
    pub metadata: NodeMetricsMetadata,
    pub usage: ResourceUsage,
}

#[derive(Debug, Deserialize)]
pub(super) struct NodeMetricsMetadata {
    pub name: String,
}

pub(super) struct NodeInfo {
    pub name: String,
    pub instance_type: String,
    pub provider: String,
    pub region: String,
    pub cpu_capacity: f64,
    pub memory_capacity_bytes: f64,
}
