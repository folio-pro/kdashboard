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
