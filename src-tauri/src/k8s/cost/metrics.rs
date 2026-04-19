use anyhow::Result;

use super::types::{
    ContainerMetrics, PodMetrics, PodMetricsList, PodMetricsMetadata, ResourceUsage,
};

// ---------------------------------------------------------------------------
// Metrics-server pod metrics
// ---------------------------------------------------------------------------

pub(super) async fn fetch_pod_metrics(
    client: &kube::Client,
    namespace: Option<&str>,
) -> Result<Vec<PodMetrics>> {
    let url = match namespace {
        Some(ns) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods", ns),
        None => "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
    };

    let request = kube::api::Request::new(&url).list(&Default::default())?;
    let response: PodMetricsList = client.request(request).await?;
    Ok(response.items)
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

pub(super) fn parse_cpu(cpu_str: &str) -> f64 {
    if let Some(nano) = cpu_str.strip_suffix('n') {
        nano.parse::<f64>().unwrap_or(0.0) / 1_000_000_000.0
    } else if let Some(micro) = cpu_str.strip_suffix('u') {
        micro.parse::<f64>().unwrap_or(0.0) / 1_000_000.0
    } else if let Some(milli) = cpu_str.strip_suffix('m') {
        milli.parse::<f64>().unwrap_or(0.0) / 1000.0
    } else {
        cpu_str.parse::<f64>().unwrap_or(0.0)
    }
}

pub(super) fn parse_memory(mem_str: &str) -> f64 {
    if let Some(ki) = mem_str.strip_suffix("Ki") {
        ki.parse::<f64>().unwrap_or(0.0) * 1024.0
    } else if let Some(mi) = mem_str.strip_suffix("Mi") {
        mi.parse::<f64>().unwrap_or(0.0) * 1024.0 * 1024.0
    } else if let Some(gi) = mem_str.strip_suffix("Gi") {
        gi.parse::<f64>().unwrap_or(0.0) * 1024.0 * 1024.0 * 1024.0
    } else if let Some(k) = mem_str.strip_suffix('k') {
        k.parse::<f64>().unwrap_or(0.0) * 1000.0
    } else if let Some(m) = mem_str.strip_suffix('M') {
        m.parse::<f64>().unwrap_or(0.0) * 1_000_000.0
    } else if let Some(g) = mem_str.strip_suffix('G') {
        g.parse::<f64>().unwrap_or(0.0) * 1_000_000_000.0
    } else {
        mem_str.parse::<f64>().unwrap_or(0.0)
    }
}

// ---------------------------------------------------------------------------
// Fallback: pod resource requests (when metrics-server unavailable)
// ---------------------------------------------------------------------------

pub(super) async fn get_pod_requests(
    client: &kube::Client,
    namespace: Option<&str>,
) -> Result<Vec<PodMetrics>> {
    use kube::api::ListParams;
    use kube::Api;

    let pods: Api<k8s_openapi::api::core::v1::Pod> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = pods.list(&ListParams::default()).await?;
    let mut result = Vec::new();

    for pod in list.items {
        let name = pod.metadata.name.unwrap_or_default();
        let ns = pod.metadata.namespace.unwrap_or_default();
        let mut containers = Vec::new();

        if let Some(spec) = pod.spec {
            for c in spec.containers {
                let resources = c.resources.as_ref();
                let requests = resources.and_then(|r| r.requests.as_ref());

                let cpu = requests
                    .and_then(|r| r.get("cpu"))
                    .map(|q| q.0.clone())
                    .unwrap_or_else(|| "100m".into());

                let memory = requests
                    .and_then(|r| r.get("memory"))
                    .map(|q| q.0.clone())
                    .unwrap_or_else(|| "128Mi".into());

                containers.push(ContainerMetrics {
                    usage: ResourceUsage { cpu, memory },
                });
            }
        }

        if !containers.is_empty() {
            result.push(PodMetrics {
                metadata: PodMetricsMetadata {
                    name,
                    namespace: ns,
                },
                containers,
            });
        }
    }

    Ok(result)
}
