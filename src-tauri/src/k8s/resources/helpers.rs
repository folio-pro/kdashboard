use kube::api::{ApiResource, DynamicObject, ObjectMeta};
use kube::Api;
use serde::Serialize;

use super::types::{Resource, ResourceMetadata};

// ---------------------------------------------------------------------------
// Convenience: build ResourceMetadata from ObjectMeta
// ---------------------------------------------------------------------------

pub fn meta_from(m: &ObjectMeta) -> ResourceMetadata {
    ResourceMetadata {
        name: m.name.clone(),
        namespace: m.namespace.clone(),
        uid: m.uid.clone(),
        resource_version: m.resource_version.clone(),
        labels: m.labels.clone(),
        annotations: m.annotations.clone(),
        creation_timestamp: m.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
        owner_references: m
            .owner_references
            .as_ref()
            .filter(|refs| !refs.is_empty())
            .and_then(|refs| serde_json::to_value(refs).ok()),
    }
}

pub fn vpa_api_resource() -> ApiResource {
    ApiResource {
        group: "autoscaling.k8s.io".to_string(),
        version: "v1".to_string(),
        api_version: "autoscaling.k8s.io/v1".to_string(),
        kind: "VerticalPodAutoscaler".to_string(),
        plural: "verticalpodautoscalers".to_string(),
    }
}

pub fn dynamic_api_for_resource(
    client: kube::Client,
    ar: &ApiResource,
    cluster_scoped: bool,
    namespace: &str,
) -> Api<DynamicObject> {
    if cluster_scoped {
        Api::all_with(client, ar)
    } else {
        Api::namespaced_with(client, namespace, ar)
    }
}

// ---------------------------------------------------------------------------
// Shared helper for binding resources (RoleBinding / ClusterRoleBinding)
// ---------------------------------------------------------------------------

pub fn binding_to_resource(
    metadata: &ObjectMeta,
    role_ref: &k8s_openapi::api::rbac::v1::RoleRef,
    subjects: &Option<Vec<k8s_openapi::api::rbac::v1::Subject>>,
    kind: &str,
) -> Resource {
    let mut spec_map = serde_json::Map::new();
    if let Ok(v) = serde_json::to_value(role_ref) {
        spec_map.insert("roleRef".to_string(), v);
    }
    if let Some(ref subj) = subjects {
        if let Ok(v) = serde_json::to_value(subj) {
            spec_map.insert("subjects".to_string(), v);
        }
    }
    Resource {
        api_version: "rbac.authorization.k8s.io/v1".to_string(),
        kind: kind.to_string(),
        metadata: meta_from(metadata),
        spec: Some(serde_json::Value::Object(spec_map)),
        status: None,
        data: None,
        type_: None,
    }
}

/// Resolve the ApiResource for a given kind string.
pub fn api_resource_for_kind(kind: &str) -> anyhow::Result<(ApiResource, bool)> {
    // Returns (ApiResource, cluster_scoped).
    let (group, version, plural, cluster_scoped) = match kind.to_lowercase().as_str() {
        "pod" => ("", "v1", "pods", false),
        "deployment" => ("apps", "v1", "deployments", false),
        "service" => ("", "v1", "services", false),
        "configmap" => ("", "v1", "configmaps", false),
        "secret" => ("", "v1", "secrets", false),
        "ingress" => ("networking.k8s.io", "v1", "ingresses", false),
        "statefulset" => ("apps", "v1", "statefulsets", false),
        "daemonset" => ("apps", "v1", "daemonsets", false),
        "job" => ("batch", "v1", "jobs", false),
        "cronjob" => ("batch", "v1", "cronjobs", false),
        "replicaset" => ("apps", "v1", "replicasets", false),
        "node" => ("", "v1", "nodes", true),
        "namespace" => ("", "v1", "namespaces", true),
        "horizontalpodautoscaler" | "hpa" => {
            ("autoscaling", "v2", "horizontalpodautoscalers", false)
        }
        "verticalpodautoscaler" | "vpa" => {
            ("autoscaling.k8s.io", "v1", "verticalpodautoscalers", false)
        }
        "event" => ("", "v1", "events", false),
        "networkpolicy" => ("networking.k8s.io", "v1", "networkpolicies", false),
        "persistentvolume" | "pv" => ("", "v1", "persistentvolumes", true),
        "persistentvolumeclaim" | "pvc" => ("", "v1", "persistentvolumeclaims", false),
        "storageclass" | "sc" => ("storage.k8s.io", "v1", "storageclasses", true),
        "role" => ("rbac.authorization.k8s.io", "v1", "roles", false),
        "rolebinding" => ("rbac.authorization.k8s.io", "v1", "rolebindings", false),
        "clusterrole" => ("rbac.authorization.k8s.io", "v1", "clusterroles", true),
        "clusterrolebinding" => (
            "rbac.authorization.k8s.io",
            "v1",
            "clusterrolebindings",
            true,
        ),
        "resourcequota" => ("", "v1", "resourcequotas", false),
        "limitrange" => ("", "v1", "limitranges", false),
        "poddisruptionbudget" | "pdb" => ("policy", "v1", "poddisruptionbudgets", false),
        _ => return Err(anyhow::anyhow!("Unsupported kind for YAML fetch: {}", kind)),
    };

    let api_version = if group.is_empty() {
        version.to_string()
    } else {
        format!("{}/{}", group, version)
    };

    Ok((
        ApiResource {
            group: group.to_string(),
            version: version.to_string(),
            api_version,
            kind: kind.to_string(),
            plural: plural.to_string(),
        },
        cluster_scoped,
    ))
}

// ---------------------------------------------------------------------------
// Field-level serialization: serialize only the fields we need instead of
// the entire K8s object (avoids double-serializing metadata/apiVersion/kind).
// ---------------------------------------------------------------------------

macro_rules! serialize_field {
    ($item:expr, spec) => {
        serde_json::to_value(&$item.spec)
            .ok()
            .filter(|v| !v.is_null())
    };
    ($item:expr, status) => {
        serde_json::to_value(&$item.status)
            .ok()
            .filter(|v| !v.is_null())
    };
    ($item:expr, data) => {
        serde_json::to_value(&$item.data)
            .ok()
            .filter(|v| !v.is_null())
    };
    ($item:expr, -) => {
        None::<serde_json::Value>
    };
}

/// Page size for K8s API list calls. Auto-paginates via continue token.
pub(super) const LIST_PAGE_SIZE: u32 = 500;

macro_rules! list_namespaced_resource {
    ($api_version:expr, $kind:expr, $type:ty, $client:expr, $namespace:expr,
     spec=$spec:tt, status=$status:tt, data=$data:tt) => {{
        let api: Api<$type> = match $namespace {
            Some(ref ns) => Api::namespaced($client.clone(), ns),
            None => Api::all($client.clone()),
        };
        let mut items: Vec<Resource> = Vec::new();
        let mut lp = ListParams::default().limit(LIST_PAGE_SIZE);
        loop {
            let list = api.list(&lp).await?;
            items.extend(list.items.iter().map(|item| Resource {
                api_version: $api_version.to_string(),
                kind: $kind.to_string(),
                metadata: meta_from(&item.metadata),
                spec: serialize_field!(item, $spec),
                status: serialize_field!(item, $status),
                data: serialize_field!(item, $data),
                type_: None,
            }));
            match list.metadata.continue_ {
                Some(ref token) if !token.is_empty() => {
                    lp = lp.continue_token(token);
                }
                _ => break,
            }
        }
        Ok(ResourceList { items })
    }};
}

macro_rules! list_cluster_resource {
    ($api_version:expr, $kind:expr, $type:ty, $client:expr,
     spec=$spec:tt, status=$status:tt) => {{
        let api: Api<$type> = Api::all($client.clone());
        let mut items: Vec<Resource> = Vec::new();
        let mut lp = ListParams::default().limit(LIST_PAGE_SIZE);
        loop {
            let list = api.list(&lp).await?;
            items.extend(list.items.iter().map(|item| Resource {
                api_version: $api_version.to_string(),
                kind: $kind.to_string(),
                metadata: meta_from(&item.metadata),
                spec: serialize_field!(item, $spec),
                status: serialize_field!(item, $status),
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
        Ok(ResourceList { items })
    }};
}

/// Helper to build a summary JSON value from a resource (used for namespace info).
#[allow(dead_code)]
pub fn resource_summary(
    meta: &ObjectMeta,
    spec: &impl Serialize,
    status: Option<&impl Serialize>,
) -> serde_json::Value {
    let mut entry = serde_json::Map::new();
    entry.insert("name".into(), serde_json::json!(meta.name));
    if let Ok(v) = serde_json::to_value(spec) {
        entry.insert("spec".into(), v);
    }
    if let Some(s) = status {
        if let Ok(v) = serde_json::to_value(s) {
            entry.insert("status".into(), v);
        }
    }
    serde_json::Value::Object(entry)
}
