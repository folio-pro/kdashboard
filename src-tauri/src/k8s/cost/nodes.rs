use anyhow::Result;
use std::collections::HashMap;

use super::metrics::{parse_cpu, parse_memory};
use super::types::NodeInfo;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub(super) const FALLBACK_CPU_RATE: f64 = 0.0325; // $/core/hr
pub(super) const FALLBACK_MEM_RATE: f64 = 0.0044; // $/GB/hr

// ---------------------------------------------------------------------------
// Cloud provider detection
// ---------------------------------------------------------------------------

pub(super) fn detect_provider(
    labels: &std::collections::BTreeMap<String, String>,
    instance_type: &str,
) -> String {
    if labels.contains_key("eks.amazonaws.com/nodegroup")
        || labels.contains_key("alpha.eksctl.io/nodegroup-name")
        || instance_type.contains('.')
    {
        "aws".into()
    } else if labels.contains_key("cloud.google.com/gke-nodepool")
        || instance_type.starts_with("e2-")
        || instance_type.starts_with("n1-")
        || instance_type.starts_with("n2-")
        || instance_type.starts_with("n2d-")
        || instance_type.starts_with("c2-")
        || instance_type.starts_with("c2d-")
        || instance_type.starts_with("c3-")
        || instance_type.starts_with("t2d-")
    {
        "gcp".into()
    } else if labels.get("kubernetes.azure.com/cluster").is_some()
        || instance_type.starts_with("Standard_")
    {
        "azure".into()
    } else {
        "unknown".into()
    }
}

// ---------------------------------------------------------------------------
// Node info retrieval
// ---------------------------------------------------------------------------

pub(super) async fn get_node_info(client: &kube::Client) -> Result<Vec<NodeInfo>> {
    use kube::api::ListParams;
    use kube::Api;

    let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let list = nodes.list(&ListParams::default()).await?;

    let mut result = Vec::new();
    for node in list.items {
        let name = node.metadata.name.unwrap_or_default();
        let labels = node.metadata.labels.unwrap_or_default();

        let instance_type = labels
            .get("node.kubernetes.io/instance-type")
            .or_else(|| labels.get("beta.kubernetes.io/instance-type"))
            .cloned()
            .unwrap_or_default();

        let region = labels
            .get("topology.kubernetes.io/region")
            .or_else(|| labels.get("failure-domain.beta.kubernetes.io/region"))
            .cloned()
            .unwrap_or_default();

        let provider = detect_provider(&labels, &instance_type);

        let capacity = node.status.as_ref().and_then(|s| s.capacity.as_ref());

        let cpu_cap = capacity
            .and_then(|c| c.get("cpu"))
            .map(|q| parse_cpu(&q.0))
            .unwrap_or(0.0);

        let mem_cap = capacity
            .and_then(|c| c.get("memory"))
            .map(|q| parse_memory(&q.0))
            .unwrap_or(0.0);

        if !instance_type.is_empty() {
            result.push(NodeInfo {
                name,
                instance_type,
                provider,
                region,
                cpu_capacity: cpu_cap,
                memory_capacity_bytes: mem_cap,
            });
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Derive per-core and per-GB rates from cloud pricing
// ---------------------------------------------------------------------------

/// Derive per-core and per-GB rates from cloud pricing.
pub(super) fn resolve_node_rates(nodes: &[NodeInfo], pricing: &HashMap<String, f64>) -> (f64, f64) {
    for node in nodes {
        let key = format!("{}/{}/{}", node.provider, node.region, node.instance_type);
        if let Some(&price_per_hour) = pricing.get(&key) {
            if node.cpu_capacity > 0.0 && node.memory_capacity_bytes > 0.0 {
                let mem_gb = node.memory_capacity_bytes / (1024.0 * 1024.0 * 1024.0);
                // Split cost 60/40 between CPU and memory (industry standard)
                let cpu_rate = (price_per_hour * 0.6) / node.cpu_capacity;
                let mem_rate = (price_per_hour * 0.4) / mem_gb;
                tracing::info!(
                    key = %key,
                    price_per_hour,
                    cpu_rate,
                    mem_rate,
                    "cost_node_matched"
                );
                return (cpu_rate, mem_rate);
            }
        }
    }

    tracing::warn!("cost_using_fallback_rates");
    (FALLBACK_CPU_RATE, FALLBACK_MEM_RATE)
}
