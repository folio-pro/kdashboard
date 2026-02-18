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

    fn sample_resource(
        spec: Option<Value>,
        status: Option<Value>,
        data: Option<Value>,
    ) -> Resource {
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
        assert!(validate_yaml(
            "apiVersion: v1\nkind: Pod\nmetadata:\n  name: demo\n"
        ));
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

    #[test]
    fn resource_to_yaml_includes_data_when_present() {
        let resource = sample_resource(
            None,
            None,
            Some(json!({"key1": "value1", "key2": "value2"})),
        );
        let yaml = resource_to_yaml(&resource).expect("yaml should serialize");
        assert!(yaml.contains("data:"));
        assert!(yaml.contains("key1: value1"));
    }

    #[test]
    fn resource_to_yaml_includes_status_when_present() {
        let resource = sample_resource(None, Some(json!({"phase": "Running"})), None);
        let yaml = resource_to_yaml(&resource).expect("yaml should serialize");
        assert!(yaml.contains("status:"));
        assert!(yaml.contains("phase: Running"));
    }

    #[test]
    fn validate_yaml_accepts_empty_document() {
        assert!(validate_yaml("---"));
    }

    #[test]
    fn validate_yaml_accepts_scalar() {
        assert!(validate_yaml("hello"));
    }

    #[test]
    fn validate_yaml_accepts_list() {
        assert!(validate_yaml("- item1\n- item2\n- item3"));
    }

    #[test]
    fn strip_nulls_preserves_arrays_with_mixed_content() {
        let input = json!([1, null, "hello", {"a": null, "b": 2}]);
        let cleaned = strip_nulls(input);
        assert_eq!(cleaned, json!([1, null, "hello", {"b": 2}]));
    }

    #[test]
    fn strip_nulls_returns_null_for_all_null_object() {
        let input = json!({"a": null, "b": null});
        assert_eq!(strip_nulls(input), Value::Null);
    }

    #[test]
    fn strip_nulls_preserves_non_null_scalars() {
        assert_eq!(strip_nulls(json!(42)), json!(42));
        assert_eq!(strip_nulls(json!("hello")), json!("hello"));
        assert_eq!(strip_nulls(json!(true)), json!(true));
        assert_eq!(strip_nulls(json!(null)), Value::Null);
    }

    #[test]
    fn reorder_fields_handles_non_object_input() {
        let input = json!("just a string");
        let result = reorder_fields(input.clone());
        assert_eq!(result, input);
    }

    #[test]
    fn reorder_fields_strips_null_sections() {
        let input = json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "spec": null,
            "status": null
        });
        let reordered = reorder_fields(input);
        let keys: Vec<String> = reordered.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["apiVersion", "kind"]);
    }

    #[test]
    fn resource_to_yaml_field_order_matches_kubectl() {
        let resource = sample_resource(
            Some(json!({"replicas": 1})),
            Some(json!({"phase": "Running"})),
            Some(json!({"config": "value"})),
        );
        let yaml = resource_to_yaml(&resource).expect("yaml should serialize");

        // Verify the JSON reorder_fields output has correct key order
        let json = serde_json::to_value(&resource).unwrap();
        let ordered = reorder_fields(json);
        let keys: Vec<String> = ordered.as_object().unwrap().keys().cloned().collect();

        // apiVersion, kind, metadata should come first; spec before data before status
        let api_idx = keys.iter().position(|k| k == "apiVersion").unwrap();
        let kind_idx = keys.iter().position(|k| k == "kind").unwrap();
        let metadata_idx = keys.iter().position(|k| k == "metadata").unwrap();
        let spec_idx = keys.iter().position(|k| k == "spec").unwrap();
        let data_idx = keys.iter().position(|k| k == "data").unwrap();
        let status_idx = keys.iter().position(|k| k == "status").unwrap();

        assert!(api_idx < kind_idx);
        assert!(kind_idx < metadata_idx);
        assert!(metadata_idx < spec_idx);
        assert!(spec_idx < data_idx);
        assert!(data_idx < status_idx);

        // Also verify the yaml contains all expected sections
        assert!(yaml.contains("apiVersion"));
        assert!(yaml.contains("spec"));
        assert!(yaml.contains("data"));
        assert!(yaml.contains("status"));
    }
}
