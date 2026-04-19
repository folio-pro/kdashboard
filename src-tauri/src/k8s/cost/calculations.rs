use anyhow::Result;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::metrics::{fetch_pod_metrics, get_pod_requests, parse_cpu, parse_memory};
use super::nodes::{get_node_info, resolve_node_rates, FALLBACK_CPU_RATE, FALLBACK_MEM_RATE};
use super::pricing::resolve_pricing;
use super::types::{CostCache, CostOverview, NamespaceCostSummary, ResourceCost};
use crate::k8s::client::get_client;

// ---------------------------------------------------------------------------
// Constants & cache
// ---------------------------------------------------------------------------

pub(super) const HOURS_PER_MONTH: f64 = 730.0;

pub(super) static COST_CACHE: Mutex<Option<CostCache>> = tokio::sync::Mutex::const_new(None);

const CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes

// ---------------------------------------------------------------------------
// Build cost overview from metrics
// ---------------------------------------------------------------------------

pub(super) async fn build_cost_from_metrics(namespace: Option<&str>) -> Result<CostOverview> {
    let client = get_client().await?;

    // Fetch in parallel: pod metrics, node info, and pricing from server
    let (pod_metrics_result, nodes_result) = tokio::join!(
        fetch_pod_metrics(&client, namespace),
        get_node_info(&client),
    );

    // If metrics-server is unavailable, fall back to pod resource requests
    let (pod_metrics, metrics_source) = match pod_metrics_result {
        Ok(metrics) => (metrics, true),
        Err(e) => {
            tracing::warn!("metrics-server unavailable ({}), using pod requests", e);
            match get_pod_requests(&client, namespace).await {
                Ok(requests) => (requests, false),
                Err(e2) => return Err(e2),
            }
        }
    };

    let nodes = nodes_result.unwrap_or_default();

    // Resolve pricing from server (sends only unique instance types, < 1 KB)
    let pricing = resolve_pricing(&nodes).await;

    tracing::info!(
        pod_count = pod_metrics.len(),
        node_count = nodes.len(),
        pricing_resolved = pricing.as_ref().map(|p| p.len()).unwrap_or(0),
        metrics_source,
        "cost_data_collected"
    );

    // Determine rates
    let (cpu_rate, mem_rate, source) = if let Some(ref lookup) = pricing {
        if !lookup.is_empty() && !nodes.is_empty() {
            let (cr, mr) = resolve_node_rates(&nodes, lookup);
            if (cr - FALLBACK_CPU_RATE).abs() > 0.0001 {
                (cr, mr, "cloud-pricing")
            } else {
                (FALLBACK_CPU_RATE, FALLBACK_MEM_RATE, "fallback")
            }
        } else {
            (FALLBACK_CPU_RATE, FALLBACK_MEM_RATE, "fallback")
        }
    } else if metrics_source {
        (FALLBACK_CPU_RATE, FALLBACK_MEM_RATE, "fallback")
    } else {
        (FALLBACK_CPU_RATE, FALLBACK_MEM_RATE, "requests")
    };

    // Group by namespace
    let mut ns_map: HashMap<String, Vec<ResourceCost>> = HashMap::new();

    for pm in &pod_metrics {
        let mut cpu_total = 0.0;
        let mut mem_total = 0.0;
        for c in &pm.containers {
            cpu_total += parse_cpu(&c.usage.cpu);
            mem_total += parse_memory(&c.usage.memory);
        }

        let cpu_cost = cpu_total * cpu_rate;
        let mem_cost = (mem_total / (1024.0 * 1024.0 * 1024.0)) * mem_rate;
        let total_hourly = cpu_cost + mem_cost;

        ns_map
            .entry(pm.metadata.namespace.clone())
            .or_default()
            .push(ResourceCost {
                name: pm.metadata.name.clone(),
                namespace: pm.metadata.namespace.clone(),
                kind: "Pod".into(),
                cpu_cores: cpu_total,
                memory_bytes: mem_total,
                cpu_cost_hourly: cpu_cost,
                memory_cost_hourly: mem_cost,
                total_cost_hourly: total_hourly,
                total_cost_monthly: total_hourly * HOURS_PER_MONTH,
            });
    }

    let mut namespaces: Vec<NamespaceCostSummary> = ns_map
        .into_iter()
        .map(|(ns, workloads)| {
            let total_cpu: f64 = workloads.iter().map(|w| w.cpu_cores).sum();
            let total_mem: f64 = workloads.iter().map(|w| w.memory_bytes).sum();
            let total_hourly: f64 = workloads.iter().map(|w| w.total_cost_hourly).sum();
            let count = workloads.len() as u32;

            NamespaceCostSummary {
                namespace: ns,
                total_cpu_cores: total_cpu,
                total_memory_gb: total_mem / (1024.0 * 1024.0 * 1024.0),
                total_cost_hourly: total_hourly,
                total_cost_monthly: total_hourly * HOURS_PER_MONTH,
                workload_count: count,
                workloads,
            }
        })
        .collect();

    namespaces.sort_by(|a, b| {
        b.total_cost_monthly
            .partial_cmp(&a.total_cost_monthly)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let cluster_hourly: f64 = namespaces.iter().map(|n| n.total_cost_hourly).sum();
    let total_cpu: f64 = namespaces.iter().map(|n| n.total_cpu_cores).sum();
    let total_mem: f64 = namespaces.iter().map(|n| n.total_memory_gb).sum();

    Ok(CostOverview {
        namespaces,
        cluster_cost_hourly: cluster_hourly,
        cluster_cost_monthly: cluster_hourly * HOURS_PER_MONTH,
        total_cpu_cores: total_cpu,
        total_memory_gb: total_mem,
        cpu_rate_per_core_hour: cpu_rate,
        memory_rate_per_gb_hour: mem_rate,
        source: source.into(),
        fetched_at: chrono::Utc::now().to_rfc3339(),
    })
}

// ---------------------------------------------------------------------------
// Public API — cached cost overview
// ---------------------------------------------------------------------------

pub async fn get_cost_overview(namespace: Option<String>) -> Result<CostOverview> {
    // Check cache first
    {
        let cache = COST_CACHE.lock().await;
        if let Some(ref cached) = *cache {
            if cached.expires_at > Instant::now() {
                if let Some(ref data) = cached.data {
                    return Ok(data.clone());
                }
            }
        }
    }

    let ns = namespace.as_deref().and_then(|n| {
        if n == "All Namespaces" || n.is_empty() {
            None
        } else {
            Some(n)
        }
    });

    let result = build_cost_from_metrics(ns).await?;

    // Update cache
    {
        let mut cache = COST_CACHE.lock().await;
        *cache = Some(CostCache {
            data: Some(result.clone()),
            expires_at: Instant::now() + CACHE_TTL,
        });
    }

    Ok(result)
}
