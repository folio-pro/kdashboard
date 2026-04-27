use anyhow::Result;
use std::collections::HashMap;

use super::calculations::HOURS_PER_MONTH;
use super::metrics::{parse_cpu, parse_memory};
use super::metrics_availability::{self, MetricsKind};
use super::nodes::get_node_info;
use super::pricing::resolve_pricing;
use super::types::{NodeCostInfo, NodeMetricsInfo, NodeMetricsList};
use crate::k8s::client::get_client;

// ---------------------------------------------------------------------------
// Node metrics (CPU/Memory usage from metrics-server)
// ---------------------------------------------------------------------------

pub async fn get_node_metrics() -> Result<Vec<NodeMetricsInfo>> {
    let client = get_client().await?;

    if !metrics_availability::is_available(MetricsKind::Nodes) {
        anyhow::bail!("metrics-server nodes endpoint marked unavailable; skipping");
    }

    let url = "/apis/metrics.k8s.io/v1beta1/nodes";
    let request = kube::api::Request::new(url).list(&Default::default())?;

    let (metrics_result, nodes) = tokio::join!(
        client.request::<NodeMetricsList>(request),
        async { get_node_info(&client).await.unwrap_or_default() },
    );

    let response: NodeMetricsList = match metrics_result {
        Ok(resp) => {
            metrics_availability::mark_available(MetricsKind::Nodes);
            resp
        }
        Err(err) => {
            let backoff = metrics_availability::mark_unavailable(MetricsKind::Nodes);
            tracing::warn!(
                backoff_secs = backoff.as_secs(),
                error = %err,
                "metrics-server nodes endpoint failed; backing off",
            );
            return Err(err.into());
        }
    };

    let capacity_map: HashMap<String, (f64, f64)> = nodes
        .into_iter()
        .map(|n| (n.name, (n.cpu_capacity, n.memory_capacity_bytes)))
        .collect();

    let result = response
        .items
        .into_iter()
        .map(|m| {
            let (cpu_cap, mem_cap) = capacity_map
                .get(&m.metadata.name)
                .copied()
                .unwrap_or((0.0, 0.0));
            let cpu_usage = parse_cpu(&m.usage.cpu);
            let mem_usage = parse_memory(&m.usage.memory);
            let cpu_pct = if cpu_cap > 0.0 {
                (cpu_usage / cpu_cap * 100.0).min(100.0)
            } else {
                0.0
            };
            let mem_pct = if mem_cap > 0.0 {
                (mem_usage / mem_cap * 100.0).min(100.0)
            } else {
                0.0
            };
            NodeMetricsInfo {
                node_name: m.metadata.name,
                cpu_usage,
                cpu_capacity: cpu_cap,
                cpu_percent: (cpu_pct * 10.0).round() / 10.0,
                memory_usage: mem_usage,
                memory_capacity: mem_cap,
                memory_percent: (mem_pct * 10.0).round() / 10.0,
            }
        })
        .collect();

    Ok(result)
}

// ---------------------------------------------------------------------------
// Node costs (for the nodes table view)
// ---------------------------------------------------------------------------

pub async fn get_node_costs() -> Result<Vec<NodeCostInfo>> {
    let client = get_client().await?;
    let nodes = get_node_info(&client).await.unwrap_or_default();
    let pricing = resolve_pricing(&nodes).await.unwrap_or_default();

    let result = nodes
        .iter()
        .map(|node| {
            let key = format!("{}/{}/{}", node.provider, node.region, node.instance_type);
            let price_per_hour = pricing.get(&key).copied().unwrap_or(0.0);
            NodeCostInfo {
                node_name: node.name.clone(),
                instance_type: node.instance_type.clone(),
                provider: node.provider.clone(),
                region: node.region.clone(),
                price_per_hour,
                price_per_month: price_per_hour * HOURS_PER_MONTH,
            }
        })
        .collect();

    Ok(result)
}
