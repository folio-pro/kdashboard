use super::discovery::{is_sensitive_field, SENSITIVE_FIELD_PATTERNS};
use super::schema::{extract_heuristic_columns, resolve_json_path};
use super::types::*;
use crate::k8s::resources::{Resource, ResourceMetadata};

fn make_resource(status: Option<serde_json::Value>, spec: Option<serde_json::Value>) -> Resource {
    Resource {
        api_version: "example.com/v1".to_string(),
        kind: "Example".to_string(),
        metadata: ResourceMetadata {
            name: Some("test".into()),
            namespace: Some("default".into()),
            ..Default::default()
        },
        spec,
        status,
        data: None,
        type_: None,
    }
}

#[test]
fn test_sensitive_field_detection() {
    assert!(is_sensitive_field("password"));
    assert!(is_sensitive_field("apiKey"));
    assert!(is_sensitive_field("secretToken"));
    assert!(is_sensitive_field("CERTIFICATE"));
    assert!(is_sensitive_field("privateKey"));
    assert!(!is_sensitive_field("replicas"));
    assert!(!is_sensitive_field("phase"));
    assert!(!is_sensitive_field("name"));
    assert!(!is_sensitive_field("ready"));
}

#[test]
fn test_extract_heuristic_columns_with_phase() {
    let resource = make_resource(
        Some(serde_json::json!({
            "phase": "Running",
            "replicas": 3,
        })),
        Some(serde_json::json!({
            "replicas": 3,
        })),
    );
    let columns = extract_heuristic_columns(&[resource], 8);
    assert!(!columns.is_empty());
    assert!(columns.iter().any(|c| c.name == "Phase"));
    assert!(columns.iter().any(|c| c.name == "Replicas"));
}

#[test]
fn test_extract_heuristic_columns_skips_sensitive() {
    let resource = make_resource(
        Some(serde_json::json!({
            "password": "secret123",
            "phase": "Active",
        })),
        None,
    );
    let columns = extract_heuristic_columns(&[resource], 8);
    assert!(columns.iter().all(|c| c.name != "password"));
    assert!(columns.iter().any(|c| c.name == "Phase"));
}

#[test]
fn test_extract_heuristic_columns_max_limit() {
    let mut status = serde_json::Map::new();
    for i in 0..20 {
        status.insert(format!("field{}", i), serde_json::json!(i));
    }
    let resource = make_resource(Some(serde_json::Value::Object(status)), None);
    let columns = extract_heuristic_columns(&[resource], 4);
    assert!(columns.len() <= 4);
}

#[test]
fn test_extract_heuristic_columns_empty_items() {
    let columns = extract_heuristic_columns(&[], 8);
    assert!(columns.is_empty());
}

#[test]
fn test_extract_heuristic_columns_skips_objects_and_arrays() {
    let resource = make_resource(
        Some(serde_json::json!({
            "phase": "Running",
            "conditions": [{"type": "Ready"}],
            "nested": {"inner": "value"},
        })),
        None,
    );
    let columns = extract_heuristic_columns(&[resource], 8);
    // Should include "phase" but not "conditions" (array) or "nested" (object)
    assert!(columns.iter().any(|c| c.name == "Phase"));
    assert!(columns.iter().all(|c| c.name != "conditions"));
    assert!(columns.iter().all(|c| c.name != "nested"));
}

#[test]
fn test_resolve_json_path_status() {
    let resource = make_resource(
        Some(serde_json::json!({"phase": "Running", "replicas": 3})),
        None,
    );
    assert_eq!(
        resolve_json_path(&resource, ".status.phase"),
        Some("Running".to_string())
    );
    assert_eq!(
        resolve_json_path(&resource, ".status.replicas"),
        Some("3".to_string())
    );
}

#[test]
fn test_resolve_json_path_spec() {
    let resource = make_resource(None, Some(serde_json::json!({"replicas": 5})));
    assert_eq!(
        resolve_json_path(&resource, ".spec.replicas"),
        Some("5".to_string())
    );
}

#[test]
fn test_resolve_json_path_metadata() {
    let resource = make_resource(None, None);
    assert_eq!(
        resolve_json_path(&resource, ".metadata.name"),
        Some("test".to_string())
    );
    assert_eq!(
        resolve_json_path(&resource, ".metadata.namespace"),
        Some("default".to_string())
    );
}

#[test]
fn test_resolve_json_path_missing() {
    let resource = make_resource(None, None);
    assert_eq!(resolve_json_path(&resource, ".status.phase"), None);
    assert_eq!(resolve_json_path(&resource, ".spec.missing"), None);
}

#[test]
fn test_extract_conditions() {
    let resource = make_resource(
        Some(serde_json::json!({
            "conditions": [
                {
                    "type": "Ready",
                    "status": "True",
                    "reason": "AllGood",
                    "message": "Everything is fine",
                    "lastTransitionTime": "2026-03-25T00:00:00Z"
                },
                {
                    "type": "Available",
                    "status": "False",
                    "reason": "NotReady"
                }
            ]
        })),
        None,
    );
    let conditions = extract_conditions(&resource);
    assert_eq!(conditions.len(), 2);
    assert_eq!(conditions[0].type_, "Ready");
    assert_eq!(conditions[0].status, "True");
    assert_eq!(conditions[0].reason.as_deref(), Some("AllGood"));
    assert_eq!(conditions[1].type_, "Available");
    assert_eq!(conditions[1].status, "False");
}

#[test]
fn test_extract_conditions_no_conditions() {
    let resource = make_resource(Some(serde_json::json!({"phase": "Running"})), None);
    let conditions = extract_conditions(&resource);
    assert!(conditions.is_empty());
}

#[test]
fn test_extract_conditions_no_status() {
    let resource = make_resource(None, None);
    let conditions = extract_conditions(&resource);
    assert!(conditions.is_empty());
}

#[test]
fn test_crd_info_serializes() {
    let info = CrdInfo {
        group: "datadoghq.com".to_string(),
        version: "v1alpha1".to_string(),
        kind: "WatermarkPodAutoscaler".to_string(),
        plural: "watermarkpodautoscalers".to_string(),
        scope: "Namespaced".to_string(),
        short_names: vec!["wpa".to_string()],
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["group"], "datadoghq.com");
    assert_eq!(json["kind"], "WatermarkPodAutoscaler");
    assert_eq!(json["scope"], "Namespaced");
}

#[test]
fn test_crd_column_serializes() {
    let col = CrdColumn {
        name: "Replicas".to_string(),
        json_path: ".status.replicas".to_string(),
        column_type: "integer".to_string(),
        description: "Current replicas".to_string(),
    };
    let json = serde_json::to_value(&col).unwrap();
    assert_eq!(json["name"], "Replicas");
    assert_eq!(json["json_path"], ".status.replicas");
}

#[test]
fn test_status_condition_serializes() {
    let cond = StatusCondition {
        type_: "Ready".to_string(),
        status: "True".to_string(),
        reason: Some("AllGood".to_string()),
        message: None,
        last_transition_time: None,
    };
    let json = serde_json::to_value(&cond).unwrap();
    assert_eq!(json["type"], "Ready");
    assert_eq!(json["status"], "True");
    assert!(json.get("message").is_none()); // skip_serializing_if
}

// --- Additional edge cases ---

// is_sensitive_field

#[test]
fn sensitive_field_empty_string() {
    assert!(!is_sensitive_field(""));
}

#[test]
fn sensitive_field_case_insensitive() {
    assert!(is_sensitive_field("Password"));
    assert!(is_sensitive_field("PASSWORD"));
    assert!(is_sensitive_field("ApiKey"));
    assert!(is_sensitive_field("APIKEY"));
    assert!(is_sensitive_field("SecretToken"));
}

#[test]
fn sensitive_field_substring_match() {
    // Should match if pattern is substring
    assert!(is_sensitive_field("db_password_hash"));
    assert!(is_sensitive_field("my-secret-field"));
    assert!(is_sensitive_field("api_token_v2"));
    assert!(is_sensitive_field("tls_certificate_data"));
    assert!(is_sensitive_field("private_key_pem"));
}

#[test]
fn sensitive_field_all_patterns() {
    for pattern in SENSITIVE_FIELD_PATTERNS {
        assert!(
            is_sensitive_field(pattern),
            "'{}' should be detected as sensitive",
            pattern
        );
    }
}

// resolve_json_path

#[test]
fn resolve_json_path_nested() {
    let resource = make_resource(
        Some(serde_json::json!({
            "containerStatuses": [{"ready": true}],
            "conditions": [{"type": "Ready"}],
            "deep": {"nested": {"value": "found"}}
        })),
        None,
    );
    assert_eq!(
        resolve_json_path(&resource, ".status.deep.nested.value"),
        Some("found".to_string())
    );
}

#[test]
fn resolve_json_path_boolean() {
    let resource = make_resource(Some(serde_json::json!({"ready": true})), None);
    assert_eq!(
        resolve_json_path(&resource, ".status.ready"),
        Some("true".to_string())
    );
}

#[test]
fn resolve_json_path_null_value() {
    let resource = make_resource(Some(serde_json::json!({"phase": null})), None);
    assert_eq!(resolve_json_path(&resource, ".status.phase"), None);
}

#[test]
fn resolve_json_path_empty_path() {
    let resource = make_resource(None, None);
    assert_eq!(resolve_json_path(&resource, ""), None);
}

#[test]
fn resolve_json_path_unknown_root() {
    let resource = make_resource(Some(serde_json::json!({"phase": "Running"})), None);
    assert_eq!(resolve_json_path(&resource, ".unknown.field"), None);
}

#[test]
fn resolve_json_path_array_value_serializes() {
    let resource = make_resource(Some(serde_json::json!({"ports": [80, 443]})), None);
    let result = resolve_json_path(&resource, ".status.ports");
    assert!(result.is_some());
    assert!(result.unwrap().contains("80"));
}

#[test]
fn resolve_json_path_metadata_creation_timestamp() {
    let mut resource = make_resource(None, None);
    resource.metadata.creation_timestamp = Some("2026-01-01T00:00:00Z".into());
    assert_eq!(
        resolve_json_path(&resource, ".metadata.creationTimestamp"),
        Some("2026-01-01T00:00:00Z".to_string())
    );
}

#[test]
fn resolve_json_path_metadata_unknown_field() {
    let resource = make_resource(None, None);
    assert_eq!(resolve_json_path(&resource, ".metadata.unknown"), None);
}

// extract_conditions

#[test]
fn extract_conditions_skips_malformed_entries() {
    let resource = make_resource(
        Some(serde_json::json!({
            "conditions": [
                {"type": "Ready", "status": "True"},
                {"missing_type": true, "status": "False"}, // no "type" field
                {"type": "Available"},                      // no "status" field
                "not-an-object"                             // not even an object
            ]
        })),
        None,
    );
    let conditions = extract_conditions(&resource);
    // Only the first entry has both type and status
    assert_eq!(conditions.len(), 1);
    assert_eq!(conditions[0].type_, "Ready");
}

#[test]
fn extract_conditions_empty_array() {
    let resource = make_resource(Some(serde_json::json!({"conditions": []})), None);
    let conditions = extract_conditions(&resource);
    assert!(conditions.is_empty());
}

#[test]
fn extract_conditions_all_optional_fields() {
    let resource = make_resource(
        Some(serde_json::json!({
            "conditions": [{
                "type": "Progressing",
                "status": "True",
                "reason": "NewReplicaSetAvailable",
                "message": "Deployment has minimum availability",
                "lastTransitionTime": "2026-03-25T12:00:00Z"
            }]
        })),
        None,
    );
    let conditions = extract_conditions(&resource);
    assert_eq!(conditions.len(), 1);
    assert_eq!(
        conditions[0].reason.as_deref(),
        Some("NewReplicaSetAvailable")
    );
    assert_eq!(
        conditions[0].message.as_deref(),
        Some("Deployment has minimum availability")
    );
    assert_eq!(
        conditions[0].last_transition_time.as_deref(),
        Some("2026-03-25T12:00:00Z")
    );
}

// extract_heuristic_columns

#[test]
fn heuristic_columns_spec_only() {
    let resource = make_resource(None, Some(serde_json::json!({"replicas": 3})));
    let columns = extract_heuristic_columns(&[resource], 8);
    assert!(
        columns.iter().any(|c| c.name == "Desired"),
        "should find spec.replicas as 'Desired'"
    );
}

#[test]
fn heuristic_columns_no_duplicates() {
    // status.replicas and spec.replicas should both appear but with different names
    let resource = make_resource(
        Some(serde_json::json!({"replicas": 3, "readyReplicas": 2})),
        Some(serde_json::json!({"replicas": 3})),
    );
    let columns = extract_heuristic_columns(&[resource], 8);
    let paths: Vec<&str> = columns.iter().map(|c| c.json_path.as_str()).collect();
    let unique: std::collections::HashSet<&&str> = paths.iter().collect();
    assert_eq!(paths.len(), unique.len(), "no duplicate paths");
}

#[test]
fn heuristic_columns_priority_ordering() {
    // .status.phase should appear before arbitrary status fields
    let resource = make_resource(
        Some(serde_json::json!({
            "zzz_custom": "value",
            "phase": "Running",
            "aaa_field": "value",
        })),
        None,
    );
    let columns = extract_heuristic_columns(&[resource], 8);
    assert!(!columns.is_empty());
    assert_eq!(columns[0].name, "Phase", "phase should be first (priority)");
}

#[test]
fn heuristic_columns_max_1() {
    let resource = make_resource(
        Some(serde_json::json!({
            "phase": "Running",
            "replicas": 3,
            "ready": true,
        })),
        None,
    );
    let columns = extract_heuristic_columns(&[resource], 1);
    assert_eq!(columns.len(), 1);
}

// Serialization roundtrips

#[test]
fn status_condition_roundtrip() {
    let cond = StatusCondition {
        type_: "Ready".to_string(),
        status: "True".to_string(),
        reason: Some("AllGood".to_string()),
        message: Some("msg".to_string()),
        last_transition_time: Some("2026-01-01T00:00:00Z".to_string()),
    };
    let json = serde_json::to_string(&cond).unwrap();
    let back: StatusCondition = serde_json::from_str(&json).unwrap();
    assert_eq!(back.type_, "Ready");
    assert_eq!(back.reason.as_deref(), Some("AllGood"));
    assert_eq!(
        back.last_transition_time.as_deref(),
        Some("2026-01-01T00:00:00Z")
    );
}

#[test]
fn crd_group_serializes() {
    let group = CrdGroup {
        group: "example.com".to_string(),
        resources: vec![CrdInfo {
            group: "example.com".to_string(),
            version: "v1".to_string(),
            kind: "Widget".to_string(),
            plural: "widgets".to_string(),
            scope: "Namespaced".to_string(),
            short_names: vec!["wg".to_string()],
        }],
    };
    let json = serde_json::to_value(&group).unwrap();
    assert_eq!(json["group"], "example.com");
    assert_eq!(json["resources"][0]["kind"], "Widget");
}

// resolve_metadata_path: uid returns None (not implemented in match)
#[test]
fn resolve_metadata_path_uid_returns_none() {
    let mut resource = make_resource(None, None);
    resource.metadata.uid = Some("abc-123".into());
    assert_eq!(resolve_json_path(&resource, ".metadata.uid"), None);
}

// resolve_metadata_path: empty parts returns None
#[test]
fn resolve_metadata_path_bare_metadata() {
    let resource = make_resource(None, None);
    assert_eq!(resolve_json_path(&resource, ".metadata"), None);
}

// is_sensitive_field: "credential" and "passphrase" specifically
#[test]
fn sensitive_field_credential_and_passphrase() {
    assert!(is_sensitive_field("credential"));
    assert!(is_sensitive_field("passphrase"));
    assert!(is_sensitive_field("my_credential_store"));
    assert!(is_sensitive_field("ssh_passphrase"));
}

// is_sensitive_field: should NOT match normal fields
#[test]
fn sensitive_field_false_negatives() {
    assert!(!is_sensitive_field("status"));
    assert!(!is_sensitive_field("namespace"));
    assert!(!is_sensitive_field("replicas"));
    assert!(!is_sensitive_field("image"));
    assert!(!is_sensitive_field("port"));
    assert!(!is_sensitive_field("labels"));
    assert!(!is_sensitive_field("annotations"));
}

// resolve_json_path: deeply nested path through spec
#[test]
fn resolve_json_path_deep_spec_path() {
    let resource = make_resource(
        None,
        Some(serde_json::json!({
            "template": {
                "spec": {
                    "containers": [{"name": "app"}]
                }
            }
        })),
    );
    assert_eq!(
        resolve_json_path(&resource, ".spec.template.spec.containers"),
        Some("[{\"name\":\"app\"}]".to_string())
    );
}

// extract_conditions: conditions is not an array (e.g., object)
#[test]
fn extract_conditions_non_array_value() {
    let resource = make_resource(
        Some(serde_json::json!({"conditions": "not-an-array"})),
        None,
    );
    let conditions = extract_conditions(&resource);
    assert!(conditions.is_empty());
}

#[test]
fn crd_resource_list_serializes() {
    let list = CrdResourceList {
        items: vec![make_resource(None, None)],
        columns: vec![CrdColumn {
            name: "Status".into(),
            json_path: ".status.phase".into(),
            column_type: "string".into(),
            description: "".into(),
        }],
    };
    let json = serde_json::to_value(&list).unwrap();
    assert_eq!(json["items"].as_array().unwrap().len(), 1);
    assert_eq!(json["columns"][0]["name"], "Status");
}
