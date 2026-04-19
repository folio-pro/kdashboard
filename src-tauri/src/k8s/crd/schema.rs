use anyhow::Result;
use kube::api::{ApiResource, DynamicObject};
use kube::Api;

use super::super::client::get_client;
use super::super::resources::Resource;
use super::discovery::is_sensitive_field;
use super::types::CrdColumn;

// ---------------------------------------------------------------------------
// CRD Schema fetch (for additionalPrinterColumns)
// ---------------------------------------------------------------------------

/// Fetch additionalPrinterColumns from the CRD definition.
pub async fn get_crd_columns(
    group: &str,
    _kind: &str,
    version: &str,
    plural: &str,
) -> Result<Vec<CrdColumn>> {
    let client = get_client().await?;

    // CRD name is {plural}.{group}
    let crd_name = format!("{}.{}", plural, group);

    let crd_api: Api<DynamicObject> = Api::all_with(
        client,
        &ApiResource {
            group: "apiextensions.k8s.io".to_string(),
            version: "v1".to_string(),
            api_version: "apiextensions.k8s.io/v1".to_string(),
            kind: "CustomResourceDefinition".to_string(),
            plural: "customresourcedefinitions".to_string(),
        },
    );

    let crd = match crd_api.get(&crd_name).await {
        Ok(crd) => crd,
        Err(_) => return Ok(vec![]), // RBAC fallback: can't read CRD def
    };

    // Extract additionalPrinterColumns from the matching version
    let columns = crd
        .data
        .pointer("/spec/versions")
        .and_then(|versions| versions.as_array())
        .and_then(|versions| {
            versions
                .iter()
                .find(|v| v.get("name").and_then(|n| n.as_str()) == Some(version))
        })
        .and_then(|ver| ver.get("additionalPrinterColumns"))
        .and_then(|cols| cols.as_array())
        .map(|cols| {
            cols.iter()
                .filter_map(|col| {
                    let name = col.get("name")?.as_str()?;
                    let json_path = col.get("jsonPath")?.as_str()?;
                    let col_type = col.get("type").and_then(|t| t.as_str()).unwrap_or("string");
                    let description = col
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("");

                    // Skip sensitive columns
                    if is_sensitive_field(name) {
                        return None;
                    }

                    // Skip "Age" column — frontend adds it automatically
                    if name == "Age" && json_path.contains("creationTimestamp") {
                        return None;
                    }

                    Some(CrdColumn {
                        name: name.to_string(),
                        json_path: json_path.to_string(),
                        column_type: col_type.to_string(),
                        description: description.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(columns)
}

// ---------------------------------------------------------------------------
// Heuristic column extraction (fallback when no additionalPrinterColumns)
// ---------------------------------------------------------------------------

/// Extract columns heuristically from .status and .spec fields.
pub fn extract_heuristic_columns(items: &[Resource], max_columns: usize) -> Vec<CrdColumn> {
    if items.is_empty() {
        return vec![];
    }

    // Sample the first item to detect fields
    let sample = &items[0];
    let mut columns = Vec::new();

    // Priority fields to look for
    let priority_paths = [
        (".status.phase", "Phase", "status"),
        (".status.replicas", "Replicas", "status"),
        (".status.readyReplicas", "Ready", "status"),
        (".status.availableReplicas", "Available", "status"),
        (".status.currentReplicas", "Current Replicas", "status"),
        (".status.desiredReplicas", "Desired Replicas", "status"),
        (".spec.replicas", "Desired", "spec"),
        (".status.observedGeneration", "Observed Gen", "status"),
    ];

    for (json_path, name, root) in &priority_paths {
        let root_val = match *root {
            "status" => sample.status.as_ref(),
            "spec" => sample.spec.as_ref(),
            _ => None,
        };
        if let Some(val) = root_val {
            // Extract the field path after .status. or .spec.
            let field = json_path.split('.').next_back().unwrap_or("");
            if val.get(field).is_some() && !is_sensitive_field(field) {
                columns.push(CrdColumn {
                    name: name.to_string(),
                    json_path: json_path.to_string(),
                    column_type: "string".to_string(),
                    description: String::new(),
                });
            }
        }
        if columns.len() >= max_columns {
            break;
        }
    }

    // If we still have room, scan top-level .status fields (depth 1 only)
    if columns.len() < max_columns {
        if let Some(status) = sample.status.as_ref().and_then(|s| s.as_object()) {
            for (key, val) in status {
                if columns.len() >= max_columns {
                    break;
                }
                if is_sensitive_field(key) {
                    continue;
                }
                // Skip complex objects/arrays, only take scalars
                if val.is_object() || val.is_array() {
                    continue;
                }
                let path = format!(".status.{}", key);
                if columns.iter().any(|c| c.json_path == path) {
                    continue;
                }
                columns.push(CrdColumn {
                    name: key.clone(),
                    json_path: path,
                    column_type: "string".to_string(),
                    description: String::new(),
                });
            }
        }
    }

    columns
}

// ---------------------------------------------------------------------------
// Extract value from a resource by JSON path
// ---------------------------------------------------------------------------

/// Resolve a simplified JSON path (e.g., ".status.phase") against a Resource.
#[cfg(test)]
pub fn resolve_json_path(resource: &Resource, path: &str) -> Option<String> {
    let parts: Vec<&str> = path.trim_start_matches('.').split('.').collect();
    if parts.is_empty() {
        return None;
    }

    let root = match parts[0] {
        "status" => resource.status.as_ref()?,
        "spec" => resource.spec.as_ref()?,
        "metadata" => return resolve_metadata_path(resource, &parts[1..]),
        _ => return None,
    };

    let mut current = root.clone();
    for part in &parts[1..] {
        current = current.get(part)?.clone();
    }

    match current {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Null => None,
        _ => Some(current.to_string()),
    }
}

#[cfg(test)]
fn resolve_metadata_path(resource: &Resource, parts: &[&str]) -> Option<String> {
    if parts.is_empty() {
        return None;
    }
    match parts[0] {
        "name" => resource.metadata.name.clone(),
        "namespace" => resource.metadata.namespace.clone(),
        "creationTimestamp" => resource.metadata.creation_timestamp.clone(),
        _ => None,
    }
}
