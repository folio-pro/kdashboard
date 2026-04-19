use anyhow::Result;
use kube::api::{ApiResource, DynamicObject, ListParams};
use kube::Api;

use super::super::client::get_client;
use super::super::resources::{meta_from, Resource};
use super::schema::{extract_heuristic_columns, get_crd_columns};
use super::types::CrdResourceList;

// ---------------------------------------------------------------------------
// List CRD resources
// ---------------------------------------------------------------------------

/// List resources for a specific CRD, with smart column extraction.
pub async fn list_crd_resources(
    group: String,
    version: String,
    kind: String,
    plural: String,
    scope: String,
    namespace: Option<String>,
) -> Result<CrdResourceList> {
    let client = get_client().await?;

    let api_version = if group.is_empty() {
        version.clone()
    } else {
        format!("{}/{}", group, version)
    };

    let ar = ApiResource {
        group: group.clone(),
        version: version.clone(),
        api_version: api_version.clone(),
        kind: kind.clone(),
        plural: plural.clone(),
    };

    let api: Api<DynamicObject> = if scope == "Cluster" {
        Api::all_with(client.clone(), &ar)
    } else {
        match namespace {
            Some(ref ns) => Api::namespaced_with(client.clone(), ns, &ar),
            None => Api::all_with(client.clone(), &ar),
        }
    };

    let mut items: Vec<Resource> = Vec::new();
    let mut lp = ListParams::default().limit(500);
    loop {
        let list = api.list(&lp).await?;
        items.extend(list.items.iter().map(|obj| Resource {
            api_version: api_version.clone(),
            kind: kind.clone(),
            metadata: meta_from(&obj.metadata),
            spec: obj.data.get("spec").cloned(),
            status: obj.data.get("status").cloned(),
            data: None,
            type_: None,
        }));
        match list.metadata.continue_ {
            Some(ref token) if !token.is_empty() => {
                lp = lp.continue_token(token);
            }
            _ => break,
        }
    }

    // Fetch columns: try additionalPrinterColumns first, fall back to heuristics
    let columns = match get_crd_columns(&group, &kind, &version, &plural).await {
        Ok(cols) if !cols.is_empty() => cols,
        _ => extract_heuristic_columns(&items, 8),
    };

    Ok(CrdResourceList { items, columns })
}
