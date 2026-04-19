use super::types::{OwnerRef, RawResource};

// ---------------------------------------------------------------------------
// Status extraction
// ---------------------------------------------------------------------------

pub(crate) fn extract_status_str(kind: &str, obj: &serde_json::Value) -> Option<String> {
    let status = obj.get("status")?;
    match kind {
        "Pod" => status
            .get("phase")
            .and_then(|v| v.as_str())
            .map(String::from),
        "Deployment" | "StatefulSet" | "DaemonSet" => {
            let conditions = status.get("conditions").and_then(|c| c.as_array());
            if let Some(conds) = conditions {
                for cond in conds {
                    let ctype = cond.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let cstatus = cond.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if ctype == "Available" {
                        return Some(if cstatus == "True" {
                            "Available".into()
                        } else {
                            "Unavailable".into()
                        });
                    }
                }
            }
            Some("Unknown".into())
        }
        "Job" => {
            let conditions = status.get("conditions").and_then(|c| c.as_array());
            if let Some(conds) = conditions {
                for cond in conds {
                    let ctype = cond.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let cstatus = cond.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if ctype == "Complete" && cstatus == "True" {
                        return Some("Complete".into());
                    }
                    if ctype == "Failed" && cstatus == "True" {
                        return Some("Failed".into());
                    }
                }
            }
            Some("Running".into())
        }
        "Service" => {
            let svc_type = obj
                .get("spec")
                .and_then(|s| s.get("type"))
                .and_then(|v| v.as_str());
            svc_type.map(String::from)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Owner reference parsing
// ---------------------------------------------------------------------------

pub(crate) fn parse_owner_refs(meta: &serde_json::Value) -> Vec<OwnerRef> {
    let refs = match meta.get("ownerReferences").and_then(|v| v.as_array()) {
        Some(r) => r,
        None => return vec![],
    };
    refs.iter()
        .filter_map(|r| {
            Some(OwnerRef {
                uid: r.get("uid")?.as_str()?.to_string(),
                kind: r.get("kind")?.as_str()?.to_string(),
                name: r.get("name")?.as_str()?.to_string(),
                api_version: r
                    .get("apiVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Dynamic → RawResource conversion
// ---------------------------------------------------------------------------

pub(crate) fn raw_from_dynamic(
    kind: &str,
    api_version: &str,
    items: Vec<serde_json::Value>,
) -> Vec<RawResource> {
    items
        .into_iter()
        .filter_map(|obj| {
            let meta = obj.get("metadata")?;
            let uid = meta.get("uid")?.as_str()?.to_string();
            let name = meta.get("name")?.as_str()?.to_string();
            let namespace = meta
                .get("namespace")
                .and_then(|v| v.as_str())
                .map(String::from);
            let owner_refs = parse_owner_refs(meta);
            let status = extract_status_str(kind, &obj);
            Some(RawResource {
                uid,
                kind: kind.to_string(),
                name,
                namespace,
                api_version: api_version.to_string(),
                status,
                owner_refs,
            })
        })
        .collect()
}

/// Fetches a typed resource list and converts to `RawResource` items.
macro_rules! fetch_typed {
    ($client:expr, $ns:expr, $type:ty, $kind:expr, $api_ver:expr) => {{
        let api: kube::Api<$type> = if let Some(ns) = $ns.as_deref() {
            kube::Api::namespaced($client.clone(), ns)
        } else {
            kube::Api::all($client.clone())
        };
        let list = api.list(&kube::api::ListParams::default()).await;
        match list {
            Ok(l) => {
                let items: Vec<serde_json::Value> = l
                    .items
                    .into_iter()
                    .filter_map(|item| serde_json::to_value(item).ok())
                    .collect();
                $crate::k8s::topology::extraction::raw_from_dynamic($kind, $api_ver, items)
            }
            Err(_) => vec![],
        }
    }};
}

pub(crate) use fetch_typed;
