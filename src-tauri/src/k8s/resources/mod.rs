pub mod types;
// helpers must come before listing — it defines macros used by listing via #[macro_use]
#[macro_use]
pub(crate) mod helpers;
pub mod counting;
pub mod events;
pub mod listing;
pub mod namespace;
pub mod operations;

// Re-export all public items so external code can still use `k8s::resources::Foo`.
// Some re-exports are only consumed via fully-qualified paths or by downstream
// serialization; suppress the unused-import lint for the whole block.
pub use counting::get_resource_counts;
pub use events::{get_events, get_resource_events};
#[allow(unused_imports)]
pub use helpers::{
    api_resource_for_kind, binding_to_resource, dynamic_api_for_resource, meta_from,
    vpa_api_resource,
};
pub use listing::{get_resource_yaml, list_pods_by_selector, list_resources};
#[allow(unused_imports)]
pub use namespace::get_namespace_info;
pub use operations::{
    apply_resource_yaml, delete_resource, list_deployment_revisions, restart_workload,
    rollback_deployment, scale_workload, RevisionInfo,
};
#[allow(unused_imports)]
pub use types::{EventItem, NamespaceInfo, Resource, ResourceList, ResourceMetadata};

#[cfg(test)]
mod tests {
    use super::helpers::api_resource_for_kind;
    use super::*;
    use kube::api::ObjectMeta;

    #[test]
    fn meta_from_extracts_basic_fields() {
        let om = ObjectMeta {
            name: Some("my-pod".into()),
            namespace: Some("default".into()),
            uid: Some("uid-123".into()),
            resource_version: Some("42".into()),
            ..Default::default()
        };
        let meta = meta_from(&om);
        assert_eq!(meta.name.as_deref(), Some("my-pod"));
        assert_eq!(meta.namespace.as_deref(), Some("default"));
        assert_eq!(meta.uid.as_deref(), Some("uid-123"));
        assert_eq!(meta.resource_version.as_deref(), Some("42"));
    }

    #[test]
    fn meta_from_handles_empty_metadata() {
        let om = ObjectMeta::default();
        let meta = meta_from(&om);
        assert!(meta.name.is_none());
        assert!(meta.namespace.is_none());
        assert!(meta.uid.is_none());
        assert!(meta.labels.is_none());
        assert!(meta.annotations.is_none());
        assert!(meta.creation_timestamp.is_none());
        assert!(meta.owner_references.is_none());
    }

    #[test]
    fn meta_from_includes_labels() {
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("app".to_string(), "nginx".to_string());
        let om = ObjectMeta {
            labels: Some(labels.clone()),
            ..Default::default()
        };
        let meta = meta_from(&om);
        assert_eq!(meta.labels.as_ref().unwrap().get("app").unwrap(), "nginx");
    }

    #[test]
    fn meta_from_excludes_empty_owner_references() {
        let om = ObjectMeta {
            owner_references: Some(vec![]),
            ..Default::default()
        };
        let meta = meta_from(&om);
        assert!(meta.owner_references.is_none());
    }

    #[test]
    fn api_resource_for_kind_resolves_common_kinds() {
        let cases = vec![
            ("pod", "pods", "", false),
            ("deployment", "deployments", "apps", false),
            ("service", "services", "", false),
            ("node", "nodes", "", true),
            ("namespace", "namespaces", "", true),
            ("configmap", "configmaps", "", false),
            ("secret", "secrets", "", false),
            ("ingress", "ingresses", "networking.k8s.io", false),
            (
                "clusterrole",
                "clusterroles",
                "rbac.authorization.k8s.io",
                true,
            ),
            (
                "clusterrolebinding",
                "clusterrolebindings",
                "rbac.authorization.k8s.io",
                true,
            ),
            ("persistentvolume", "persistentvolumes", "", true),
            ("storageclass", "storageclasses", "storage.k8s.io", true),
        ];

        for (kind, expected_plural, expected_group, expected_cluster) in cases {
            let (ar, cluster_scoped) = api_resource_for_kind(kind).unwrap();
            assert_eq!(
                ar.plural, expected_plural,
                "plural mismatch for kind={}",
                kind
            );
            assert_eq!(ar.group, expected_group, "group mismatch for kind={}", kind);
            assert_eq!(
                cluster_scoped, expected_cluster,
                "scope mismatch for kind={}",
                kind
            );
        }
    }

    #[test]
    fn api_resource_for_kind_supports_aliases() {
        let (ar, _) = api_resource_for_kind("hpa").unwrap();
        assert_eq!(ar.plural, "horizontalpodautoscalers");

        let (ar, _) = api_resource_for_kind("pv").unwrap();
        assert_eq!(ar.plural, "persistentvolumes");

        let (ar, _) = api_resource_for_kind("pvc").unwrap();
        assert_eq!(ar.plural, "persistentvolumeclaims");

        let (ar, _) = api_resource_for_kind("sc").unwrap();
        assert_eq!(ar.plural, "storageclasses");

        let (ar, _) = api_resource_for_kind("pdb").unwrap();
        assert_eq!(ar.plural, "poddisruptionbudgets");
    }

    #[test]
    fn api_resource_for_kind_returns_error_for_unknown() {
        assert!(api_resource_for_kind("unknownkind").is_err());
    }

    #[test]
    fn api_resource_api_version_format() {
        // Core resources have simple api_version
        let (ar, _) = api_resource_for_kind("pod").unwrap();
        assert_eq!(ar.api_version, "v1");

        // Group resources have group/version
        let (ar, _) = api_resource_for_kind("deployment").unwrap();
        assert_eq!(ar.api_version, "apps/v1");
    }

    #[test]
    fn vpa_api_resource_is_correct() {
        let ar = vpa_api_resource();
        assert_eq!(ar.group, "autoscaling.k8s.io");
        assert_eq!(ar.version, "v1");
        assert_eq!(ar.kind, "VerticalPodAutoscaler");
        assert_eq!(ar.plural, "verticalpodautoscalers");
    }

    #[test]
    fn dynamic_api_for_resource_cluster_scoped() {
        // Can't test without a real client, but verify the function exists and compiles
        // by checking it via api_resource_for_kind
        let (_, cluster_scoped) = api_resource_for_kind("node").unwrap();
        assert!(cluster_scoped);
    }

    #[test]
    fn resource_metadata_serializes_correctly() {
        let meta = ResourceMetadata {
            name: Some("test".into()),
            namespace: Some("default".into()),
            uid: Some("uid-1".into()),
            resource_version: Some("1".into()),
            labels: None,
            annotations: None,
            creation_timestamp: None,
            owner_references: None,
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["name"], "test");
        assert_eq!(json["namespace"], "default");
        assert_eq!(json["uid"], "uid-1");
    }

    #[test]
    fn resource_serializes_with_skip_none() {
        let resource = Resource {
            api_version: "v1".to_string(),
            kind: "Pod".to_string(),
            metadata: ResourceMetadata::default(),
            spec: None,
            status: None,
            data: None,
            type_: None,
        };
        let json = serde_json::to_string(&resource).unwrap();
        assert!(!json.contains("\"spec\""));
        assert!(!json.contains("\"status\""));
        assert!(!json.contains("\"data\""));
        assert!(!json.contains("\"type\""));
    }

    #[test]
    fn resource_deserializes_from_json() {
        let json = r#"{
            "api_version": "v1",
            "kind": "Pod",
            "metadata": {"name": "test"},
            "spec": {"containers": []},
            "status": {"phase": "Running"}
        }"#;
        let resource: Resource = serde_json::from_str(json).unwrap();
        assert_eq!(resource.kind, "Pod");
        assert_eq!(resource.metadata.name.as_deref(), Some("test"));
        assert!(resource.spec.is_some());
        assert!(resource.status.is_some());
    }

    #[test]
    fn event_item_serializes_type_field() {
        let event = EventItem {
            name: Some("test-event".into()),
            namespace: Some("default".into()),
            reason: Some("Scheduled".into()),
            message: Some("Successfully assigned".into()),
            type_: Some("Normal".into()),
            involved_object: None,
            first_timestamp: None,
            last_timestamp: None,
            count: Some(1),
            source: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "Normal");
        assert_eq!(json["count"], 1);
    }

    #[test]
    fn binding_to_resource_builds_correct_structure() {
        use k8s_openapi::api::rbac::v1::{RoleRef, Subject};

        let meta = ObjectMeta {
            name: Some("my-binding".into()),
            namespace: Some("default".into()),
            ..Default::default()
        };
        let role_ref = RoleRef {
            api_group: "rbac.authorization.k8s.io".to_string(),
            kind: "Role".to_string(),
            name: "my-role".to_string(),
        };
        let subjects = Some(vec![Subject {
            kind: "ServiceAccount".to_string(),
            name: "my-sa".to_string(),
            namespace: Some("default".to_string()),
            api_group: None,
        }]);

        let resource = binding_to_resource(&meta, &role_ref, &subjects, "RoleBinding");
        assert_eq!(resource.kind, "RoleBinding");
        assert_eq!(resource.api_version, "rbac.authorization.k8s.io/v1");
        assert!(resource.spec.is_some());

        let spec = resource.spec.unwrap();
        assert!(spec.get("roleRef").is_some());
        assert!(spec.get("subjects").is_some());
    }

    #[test]
    fn namespace_info_serializes() {
        let info = NamespaceInfo {
            namespace: "default".to_string(),
            resource_quotas: vec![],
            limit_ranges: vec![],
            resource_counts: std::collections::HashMap::new(),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["namespace"], "default");
        assert!(json["resource_quotas"].as_array().unwrap().is_empty());
    }

    #[test]
    fn resource_list_serializes() {
        let list = ResourceList { items: vec![] };
        let json = serde_json::to_value(&list).unwrap();
        assert!(json["items"].as_array().unwrap().is_empty());
    }

    // -----------------------------------------------------------------------
    // api_resource_for_kind -- plural names (e.g. "pods") are not accepted
    // -----------------------------------------------------------------------

    #[test]
    fn api_resource_for_kind_rejects_plural_forms() {
        // The function expects singular kind names (e.g. "pod"), not plural
        assert!(api_resource_for_kind("pods").is_err());
        assert!(api_resource_for_kind("deployments").is_err());
        assert!(api_resource_for_kind("services").is_err());
    }

    #[test]
    fn api_resource_for_kind_is_case_insensitive() {
        let (ar, _) = api_resource_for_kind("Pod").unwrap();
        assert_eq!(ar.plural, "pods");

        let (ar, _) = api_resource_for_kind("DEPLOYMENT").unwrap();
        assert_eq!(ar.plural, "deployments");

        let (ar, _) = api_resource_for_kind("Service").unwrap();
        assert_eq!(ar.plural, "services");
    }

    #[test]
    fn api_resource_for_kind_resolves_all_supported_kinds() {
        let kinds = vec![
            "pod",
            "deployment",
            "service",
            "configmap",
            "secret",
            "ingress",
            "statefulset",
            "daemonset",
            "job",
            "cronjob",
            "replicaset",
            "node",
            "namespace",
            "horizontalpodautoscaler",
            "hpa",
            "verticalpodautoscaler",
            "vpa",
            "event",
            "networkpolicy",
            "persistentvolume",
            "pv",
            "persistentvolumeclaim",
            "pvc",
            "storageclass",
            "sc",
            "role",
            "rolebinding",
            "clusterrole",
            "clusterrolebinding",
            "resourcequota",
            "limitrange",
            "poddisruptionbudget",
            "pdb",
        ];
        for kind in kinds {
            let result = api_resource_for_kind(kind);
            assert!(result.is_ok(), "Failed to resolve kind: {}", kind);
        }
    }

    #[test]
    fn api_resource_for_kind_unknown_returns_descriptive_error() {
        let err = api_resource_for_kind("foobar").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("foobar"),
            "Error should mention the unknown kind"
        );
        assert!(
            msg.contains("Unsupported kind"),
            "Error should describe the problem"
        );
    }

    // -----------------------------------------------------------------------
    // meta_from -- fully populated ObjectMeta
    // -----------------------------------------------------------------------

    #[test]
    fn meta_from_fully_populated() {
        use chrono::{TimeZone, Utc};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

        let mut labels = std::collections::BTreeMap::new();
        labels.insert("app".to_string(), "nginx".to_string());
        labels.insert("tier".to_string(), "frontend".to_string());

        let mut annotations = std::collections::BTreeMap::new();
        annotations.insert(
            "kubectl.kubernetes.io/last-applied-configuration".to_string(),
            "{}".to_string(),
        );

        let owner_ref = OwnerReference {
            api_version: "apps/v1".to_string(),
            kind: "ReplicaSet".to_string(),
            name: "my-rs-abc123".to_string(),
            uid: "owner-uid-456".to_string(),
            controller: Some(true),
            block_owner_deletion: Some(true),
        };

        let ts = Utc.with_ymd_and_hms(2025, 3, 15, 10, 30, 0).unwrap();

        let om = ObjectMeta {
            name: Some("my-pod".into()),
            namespace: Some("production".into()),
            uid: Some("uid-789".into()),
            resource_version: Some("12345".into()),
            labels: Some(labels),
            annotations: Some(annotations),
            creation_timestamp: Some(Time(ts)),
            owner_references: Some(vec![owner_ref]),
            ..Default::default()
        };

        let meta = meta_from(&om);
        assert_eq!(meta.name.as_deref(), Some("my-pod"));
        assert_eq!(meta.namespace.as_deref(), Some("production"));
        assert_eq!(meta.uid.as_deref(), Some("uid-789"));
        assert_eq!(meta.resource_version.as_deref(), Some("12345"));

        // Labels
        let labels = meta.labels.as_ref().unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels.get("app").unwrap(), "nginx");
        assert_eq!(labels.get("tier").unwrap(), "frontend");

        // Annotations
        let anns = meta.annotations.as_ref().unwrap();
        assert!(anns.contains_key("kubectl.kubernetes.io/last-applied-configuration"));

        // creation_timestamp is an RFC3339 string
        let ts_str = meta.creation_timestamp.as_ref().unwrap();
        assert!(ts_str.contains("2025"));

        // owner_references is a JSON Value (array)
        let refs = meta.owner_references.as_ref().unwrap();
        assert!(refs.is_array());
        let arr = refs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["kind"], "ReplicaSet");
        assert_eq!(arr[0]["name"], "my-rs-abc123");
    }
}
