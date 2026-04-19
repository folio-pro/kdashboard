use anyhow::Result;
use k8s_openapi::api::core::v1::{LimitRange, ResourceQuota};
use kube::api::ListParams;
use kube::Api;

use super::counting::get_resource_counts;
use super::helpers::resource_summary;
use super::types::NamespaceInfo;
use crate::k8s::client::get_client;

#[allow(dead_code)]
const NAMESPACE_COUNT_TYPES: &[&str] =
    &["pods", "deployments", "services", "configmaps", "secrets"];

#[allow(dead_code)]
pub async fn get_namespace_info(namespace: &str) -> Result<NamespaceInfo> {
    let client = get_client().await?;

    let quotas_api: Api<ResourceQuota> = Api::namespaced(client.clone(), namespace);
    let limits_api: Api<LimitRange> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default();
    let lp2 = ListParams::default();

    let count_types: Vec<String> = NAMESPACE_COUNT_TYPES
        .iter()
        .map(|s| s.to_string())
        .collect();
    let (quotas_res, limits_res, counts_res) = tokio::join!(
        quotas_api.list(&lp),
        limits_api.list(&lp2),
        get_resource_counts(count_types, Some(namespace.to_string())),
    );

    let resource_quotas: Vec<serde_json::Value> = quotas_res?
        .items
        .iter()
        .map(|q| resource_summary(&q.metadata, &q.spec, q.status.as_ref()))
        .collect();

    let limit_ranges: Vec<serde_json::Value> = limits_res?
        .items
        .iter()
        .map(|lr| resource_summary(&lr.metadata, &lr.spec, None::<&serde_json::Value>))
        .collect();

    Ok(NamespaceInfo {
        namespace: namespace.to_string(),
        resource_quotas,
        limit_ranges,
        resource_counts: counts_res?,
    })
}
