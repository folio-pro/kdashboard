use anyhow::Result;
use kube::api::{ApiResource, DynamicObject, ListParams};
use kube::Api;
use std::collections::HashMap;

use super::super::client::get_client;
use super::discovery::api_semaphore;
use super::types::CrdInfo;

// ---------------------------------------------------------------------------
// Count CRD resources (with semaphore)
// ---------------------------------------------------------------------------

/// Count resources for multiple CRD types, respecting the shared API semaphore.
pub async fn get_crd_counts(
    crds: Vec<CrdInfo>,
    namespace: Option<String>,
) -> Result<HashMap<String, u32>> {
    let client = get_client().await?;
    let sem = api_semaphore();

    let futures: Vec<_> = crds
        .into_iter()
        .map(|crd| {
            let ns = namespace.clone();
            let c = client.clone();
            let sem = sem.clone();
            async move {
                let _permit = sem.acquire().await.ok();
                let api_version = if crd.group.is_empty() {
                    crd.version.clone()
                } else {
                    format!("{}/{}", crd.group, crd.version)
                };

                let ar = ApiResource {
                    group: crd.group.clone(),
                    version: crd.version.clone(),
                    api_version,
                    kind: crd.kind.clone(),
                    plural: crd.plural.clone(),
                };

                let api: Api<DynamicObject> = if crd.scope == "Cluster" {
                    Api::all_with(c, &ar)
                } else {
                    match ns {
                        Some(ref ns) => Api::namespaced_with(c, ns, &ar),
                        None => Api::all_with(c, &ar),
                    }
                };

                let count = match api.list(&ListParams::default().limit(1)).await {
                    Ok(list) => list
                        .metadata
                        .remaining_item_count
                        .map(|c| c as u32 + list.items.len() as u32)
                        .unwrap_or(list.items.len() as u32),
                    Err(_) => 0,
                };

                // Key: group/kind for uniqueness
                let key = format!("{}/{}", crd.group, crd.kind);
                (key, count)
            }
        })
        .collect();

    Ok(futures::future::join_all(futures)
        .await
        .into_iter()
        .collect())
}
