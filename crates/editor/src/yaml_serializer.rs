use anyhow::Result;
use k8s_client::Resource;
use serde_json::Value;

/// Convert a Resource to a well-ordered YAML string.
///
/// Fields are ordered: apiVersion, kind, metadata, spec, data, type, status
/// to match standard kubectl output conventions.
pub fn resource_to_yaml(resource: &Resource) -> Result<String> {
    let json = serde_json::to_value(resource)?;
    let ordered = reorder_fields(json);
    let yaml = serde_yaml::to_string(&ordered)?;
    Ok(yaml)
}

/// Reorder top-level fields to match kubectl conventions and strip nulls.
fn reorder_fields(value: Value) -> Value {
    let obj = match value {
        Value::Object(map) => map,
        other => return strip_nulls(other),
    };

    let key_order = [
        "apiVersion",
        "kind",
        "metadata",
        "spec",
        "data",
        "type",
        "status",
    ];

    let mut ordered = serde_json::Map::new();

    // Insert known keys in order
    for key in &key_order {
        if let Some(val) = obj.get(*key) {
            let cleaned = strip_nulls(val.clone());
            if cleaned != Value::Null {
                ordered.insert((*key).to_string(), cleaned);
            }
        }
    }

    // Insert any remaining keys not in the predefined order
    for (key, val) in &obj {
        if !key_order.contains(&key.as_str()) {
            let cleaned = strip_nulls(val.clone());
            if cleaned != Value::Null {
                ordered.insert(key.clone(), cleaned);
            }
        }
    }

    Value::Object(ordered)
}

/// Validate whether a string is valid YAML.
pub fn validate_yaml(content: &str) -> bool {
    serde_yaml::from_str::<serde_yaml::Value>(content).is_ok()
}

/// Recursively remove null values from JSON.
fn strip_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let cleaned: serde_json::Map<String, Value> = map
                .into_iter()
                .filter_map(|(k, v)| {
                    let cleaned = strip_nulls(v);
                    if cleaned == Value::Null {
                        None
                    } else {
                        Some((k, cleaned))
                    }
                })
                .collect();
            if cleaned.is_empty() {
                Value::Null
            } else {
                Value::Object(cleaned)
            }
        }
        Value::Array(arr) => {
            let cleaned: Vec<Value> = arr.into_iter().map(strip_nulls).collect();
            Value::Array(cleaned)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_client::{Resource, ResourceMetadata};
    use serde_json::json;

    fn sample_resource(spec: Option<Value>, status: Option<Value>, data: Option<Value>) -> Resource {
        Resource {
            api_version: "v1".to_string(),
            kind: "ConfigMap".to_string(),
            metadata: ResourceMetadata {
                name: "demo".to_string(),
                namespace: Some("default".to_string()),
                uid: "uid-1".to_string(),
                resource_version: "1".to_string(),
                labels: None,
                annotations: None,
                creation_timestamp: None,
                owner_references: None,
            },
            spec,
            status,
            data,
            type_: None,
        }
    }

    #[test]
    fn validate_yaml_accepts_valid_yaml() {
        assert!(validate_yaml("apiVersion: v1\nkind: Pod\nmetadata:\n  name: demo\n"));
    }

    #[test]
    fn validate_yaml_rejects_invalid_yaml() {
        assert!(!validate_yaml("apiVersion: v1\nkind: ["));
    }

    #[test]
    fn strip_nulls_removes_null_keys_and_empty_objects() {
        let input = json!({
            "a": null,
            "b": {
                "x": null,
                "y": 1
            },
            "c": {
                "k": null
            },
            "d": [null, {"z": null}, {"z": 2}]
        });

        let cleaned = strip_nulls(input);
        assert_eq!(cleaned, json!({"b": {"y": 1}, "d": [null, null, {"z": 2}]}));
    }

    #[test]
    fn reorder_fields_applies_expected_key_order() {
        let input = json!({
            "status": {"phase": "Running"},
            "z_extra": 1,
            "kind": "Pod",
            "metadata": {"name": "demo"},
            "apiVersion": "v1",
            "spec": {"containers": []}
        });
        let reordered = reorder_fields(input);

        let keys: Vec<String> = reordered
            .as_object()
            .expect("expected object")
            .keys()
            .cloned()
            .collect();

        assert_eq!(
            keys,
            vec![
                "apiVersion".to_string(),
                "kind".to_string(),
                "metadata".to_string(),
                "spec".to_string(),
                "status".to_string(),
                "z_extra".to_string()
            ]
        );
    }

    #[test]
    fn resource_to_yaml_omits_null_top_level_sections() {
        let resource = sample_resource(Some(json!({"replicas": 1})), None, None);
        let yaml = resource_to_yaml(&resource).expect("yaml should serialize");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("valid yaml");
        let map = parsed.as_mapping().expect("top-level yaml mapping");

        assert!(yaml.contains("apiVersion: v1"));
        assert!(yaml.contains("kind: ConfigMap"));
        assert!(map.contains_key(serde_yaml::Value::String("spec".to_string())));
        assert!(!map.contains_key(serde_yaml::Value::String("status".to_string())));
        assert!(!map.contains_key(serde_yaml::Value::String("data".to_string())));
    }
}
