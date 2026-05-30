use anyhow::Result;
use base64::Engine;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, LimitRange, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod,
    ResourceQuota, Secret, Service,
};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::storage::v1::StorageClass;
use kube::api::{DynamicObject, ListParams};
use kube::core::Object;
use kube::Api;
use serde::{Deserialize, Serialize};

use super::helpers::{
    api_resource_for_kind, binding_to_resource, dynamic_api_for_resource, meta_from,
    vpa_api_resource, LIST_PAGE_SIZE,
};
use super::types::{Resource, ResourceList};
use crate::k8s::client::get_client;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List resources of the given type, optionally scoped to a namespace.
pub async fn list_resources(
    resource_type: &str,
    namespace: Option<String>,
) -> Result<ResourceList> {
    let client = get_client().await?;

    match resource_type {
        // KDASH_BENCH_NOPROJ=1 routes pods through the old full-object path so the
        // projection can be A/B-benchmarked on the same cluster. Bench-only escape hatch.
        "pods" if std::env::var("KDASH_BENCH_NOPROJ").as_deref() == Ok("1") => {
            list_namespaced_resource!("v1", "Pod", Pod, client, namespace,
                spec = spec, status = status, data = -)
        }
        "pods" => list_pods_projected(client, namespace).await,
        "deployments" => {
            list_namespaced_resource!("apps/v1", "Deployment", Deployment, client, namespace,
            spec=spec, status=status, data=-)
        }
        "services" => list_namespaced_resource!("v1", "Service", Service, client, namespace,
            spec=spec, status=status, data=-),
        "configmaps" => list_namespaced_resource!("v1", "ConfigMap", ConfigMap, client, namespace,
            spec=-, status=-, data=data),
        "secrets" => list_secrets(client, namespace).await,
        "ingresses" => {
            list_namespaced_resource!("networking.k8s.io/v1", "Ingress", Ingress, client, namespace,
            spec=spec, status=status, data=-)
        }
        "statefulsets" => {
            list_namespaced_resource!("apps/v1", "StatefulSet", StatefulSet, client, namespace,
            spec=spec, status=status, data=-)
        }
        "daemonsets" => {
            list_namespaced_resource!("apps/v1", "DaemonSet", DaemonSet, client, namespace,
            spec=spec, status=status, data=-)
        }
        "jobs" => list_namespaced_resource!("batch/v1", "Job", Job, client, namespace,
            spec=spec, status=status, data=-),
        "cronjobs" => list_namespaced_resource!("batch/v1", "CronJob", CronJob, client, namespace,
            spec=spec, status=status, data=-),
        "replicasets" => {
            list_namespaced_resource!("apps/v1", "ReplicaSet", ReplicaSet, client, namespace,
            spec=spec, status=status, data=-)
        }
        "nodes" => list_cluster_resource!("v1", "Node", Node, client, spec = spec, status = status),
        "namespaces" => list_cluster_resource!(
            "v1",
            "Namespace",
            Namespace,
            client,
            spec = spec,
            status = status
        ),
        "hpa" => {
            list_namespaced_resource!("autoscaling/v2", "HorizontalPodAutoscaler", HorizontalPodAutoscaler, client, namespace,
            spec=spec, status=status, data=-)
        }
        "vpa" => list_vpa(client, namespace).await,
        "networkpolicies" => {
            list_namespaced_resource!("networking.k8s.io/v1", "NetworkPolicy", NetworkPolicy, client, namespace, spec=spec, status=-, data=-)
        }
        "persistentvolumes" => list_cluster_resource!(
            "v1",
            "PersistentVolume",
            PersistentVolume,
            client,
            spec = spec,
            status = status
        ),
        "persistentvolumeclaims" => {
            list_namespaced_resource!("v1", "PersistentVolumeClaim", PersistentVolumeClaim, client, namespace, spec=spec, status=status, data=-)
        }
        "storageclasses" => {
            list_cluster_resource!("storage.k8s.io/v1", "StorageClass", StorageClass, client, spec=-, status=-)
        }
        "roles" => {
            list_namespaced_resource!("rbac.authorization.k8s.io/v1", "Role", Role, client, namespace, spec=-, status=-, data=-)
        }
        "rolebindings" => {
            let api: Api<RoleBinding> = match namespace {
                Some(ref ns) => Api::namespaced(client.clone(), ns),
                None => Api::all(client.clone()),
            };
            let list = api.list(&ListParams::default()).await?;
            let items: Vec<Resource> = list
                .items
                .iter()
                .map(|item| {
                    binding_to_resource(
                        &item.metadata,
                        &item.role_ref,
                        &item.subjects,
                        "RoleBinding",
                    )
                })
                .collect();
            Ok(ResourceList { items })
        }
        "clusterroles" => {
            list_cluster_resource!("rbac.authorization.k8s.io/v1", "ClusterRole", ClusterRole, client, spec=-, status=-)
        }
        "clusterrolebindings" => {
            let api: Api<ClusterRoleBinding> = Api::all(client.clone());
            let list = api.list(&ListParams::default()).await?;
            let items: Vec<Resource> = list
                .items
                .iter()
                .map(|item| {
                    binding_to_resource(
                        &item.metadata,
                        &item.role_ref,
                        &item.subjects,
                        "ClusterRoleBinding",
                    )
                })
                .collect();
            Ok(ResourceList { items })
        }
        "resourcequotas" => {
            list_namespaced_resource!("v1", "ResourceQuota", ResourceQuota, client, namespace, spec=spec, status=status, data=-)
        }
        "limitranges" => {
            list_namespaced_resource!("v1", "LimitRange", LimitRange, client, namespace, spec=spec, status=-, data=-)
        }
        "poddisruptionbudgets" => {
            list_namespaced_resource!("policy/v1", "PodDisruptionBudget", PodDisruptionBudget, client, namespace, spec=spec, status=status, data=-)
        }
        other => Err(anyhow::anyhow!("Unknown resource type: {}", other)),
    }
}

// ---------------------------------------------------------------------------
// Pods: projected list path
//
// Pods are the heaviest list (full spec + status, dominated by per-container
// status). The table only needs a handful of fields, so we deserialize the API
// response DIRECTLY into lean structs via `kube::core::Object` — this skips
// building the full k8s-openapi Pod AND avoids shipping spec/status the table
// never reads. The detail panel re-fetches the full object on demand
// (`get_resource`), so nothing downstream loses fidelity.
//
// IMPORTANT: every field the pods table/row reads must stay in these structs
// (see TableRow.getCellValue + container status rendering): spec.nodeName,
// spec.containers[].{name,image}, status.{phase,podIP,hostIP,startTime},
// status.conditions[].{type,status},
// status.containerStatuses[].{name,ready,restartCount,image,state,started}.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PodSpecProj {
    #[serde(skip_serializing_if = "Option::is_none")]
    node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    containers: Option<Vec<ContainerProj>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    init_containers: Option<Vec<ContainerProj>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContainerProj {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PodStatusProj {
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pod_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conditions: Option<Vec<ConditionProj>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    container_statuses: Option<Vec<ContainerStatusProj>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    init_container_statuses: Option<Vec<ContainerStatusProj>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConditionProj {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    type_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContainerStatusProj {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restart_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    // `state` is small ({running|waiting|terminated:{reason,exitCode}}) and the
    // row uses waiting.reason / terminated.exitCode — keep it verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started: Option<bool>,
}

/// List pods, projecting to only the fields the table renders. Deserializes the
/// API body straight into lean structs (no full k8s-openapi Pod, no managedFields).
async fn list_pods_projected(
    client: kube::Client,
    namespace: Option<String>,
) -> Result<ResourceList> {
    let ar = kube::api::ApiResource::erase::<Pod>(&());
    let api: Api<Object<PodSpecProj, PodStatusProj>> = match namespace {
        Some(ref ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };

    let mut items: Vec<Resource> = Vec::new();
    let mut lp = ListParams::default().limit(LIST_PAGE_SIZE);
    loop {
        let list = api.list(&lp).await?;
        items.reserve(list.items.len());
        for obj in list.items {
            items.push(Resource {
                api_version: "v1".to_string(),
                kind: "Pod".to_string(),
                metadata: meta_from(&obj.metadata),
                spec: serde_json::to_value(&obj.spec).ok().filter(|v| !v.is_null()),
                status: obj
                    .status
                    .as_ref()
                    .and_then(|s| serde_json::to_value(s).ok())
                    .filter(|v| !v.is_null()),
                data: None,
                type_: None,
            });
        }
        match list.metadata.continue_ {
            Some(ref token) if !token.is_empty() => {
                lp = lp.continue_token(token);
            }
            _ => break,
        }
    }
    Ok(ResourceList { items })
}

/// Fetch a single resource with its FULL spec/status/data — used by the detail
/// panel to hydrate after a projected (lean) list. `kind` is the singular kind
/// string (e.g. "Pod", "Deployment") understood by `api_resource_for_kind`.
pub async fn get_resource(kind: &str, name: &str, namespace: &str) -> Result<Resource> {
    let client = get_client().await?;
    let (ar, cluster_scoped) = api_resource_for_kind(kind)?;
    let api = dynamic_api_for_resource(client, &ar, cluster_scoped, namespace);

    let mut obj = api.get(name).await?;
    obj.metadata.managed_fields = None;

    let mut map = match obj.data {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    Ok(Resource {
        api_version: ar.api_version.clone(),
        kind: kind.to_string(),
        metadata: meta_from(&obj.metadata),
        spec: map.remove("spec").filter(|v| !v.is_null()),
        status: map.remove("status").filter(|v| !v.is_null()),
        data: map.remove("data").filter(|v| !v.is_null()),
        type_: map
            .remove("type")
            .and_then(|v| v.as_str().map(|s| s.to_string())),
    })
}

// ---------------------------------------------------------------------------
// Secrets (special handling: base64-encode data values, expose type_)
// ---------------------------------------------------------------------------

async fn list_secrets(client: kube::Client, namespace: Option<String>) -> Result<ResourceList> {
    let api: Api<Secret> = match namespace {
        Some(ref ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let list = api.list(&ListParams::default()).await?;

    let engine = base64::engine::general_purpose::STANDARD;
    let items: Vec<Resource> = list
        .items
        .iter()
        .map(|secret| {
            // Base64-encode each data value so the frontend receives safe strings.
            let encoded_data: Option<serde_json::Value> = secret.data.as_ref().map(|data_map| {
                let map: serde_json::Map<String, serde_json::Value> = data_map
                    .iter()
                    .map(|(k, v)| (k.clone(), serde_json::Value::String(engine.encode(&v.0))))
                    .collect();
                serde_json::Value::Object(map)
            });

            Resource {
                api_version: "v1".to_string(),
                kind: "Secret".to_string(),
                metadata: meta_from(&secret.metadata),
                spec: None,
                status: None,
                data: encoded_data.or_else(|| {
                    // Fall back to string_data if binary data is absent.
                    secret
                        .string_data
                        .as_ref()
                        .and_then(|sd| serde_json::to_value(sd).ok())
                }),
                type_: secret.type_.clone(),
            }
        })
        .collect();

    Ok(ResourceList { items })
}

// ---------------------------------------------------------------------------
// VPA via DynamicObject (CRD, not in k8s-openapi)
// ---------------------------------------------------------------------------

async fn list_vpa(client: kube::Client, namespace: Option<String>) -> Result<ResourceList> {
    let ar = vpa_api_resource();

    let api: Api<DynamicObject> = match namespace {
        Some(ref ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };

    let list = api.list(&ListParams::default()).await?;
    let items: Vec<Resource> = list
        .items
        .iter()
        .map(|obj| {
            // DynamicObject.data is already a serde_json::Value map -- no need to re-serialize
            Resource {
                api_version: "autoscaling.k8s.io/v1".to_string(),
                kind: "VerticalPodAutoscaler".to_string(),
                metadata: meta_from(&obj.metadata),
                spec: obj.data.get("spec").cloned(),
                status: obj.data.get("status").cloned(),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList { items })
}

/// List pods matching the given label selector (e.g. "app=nginx,tier=frontend").
pub async fn list_pods_by_selector(namespace: &str, selector: &str) -> Result<ResourceList> {
    let client = get_client().await?;

    let api: Api<Pod> = if namespace.is_empty() {
        Api::all(client)
    } else {
        Api::namespaced(client, namespace)
    };

    let lp = ListParams::default().labels(selector);
    let list = api.list(&lp).await?;

    let items: Vec<Resource> = list
        .items
        .iter()
        .map(|item| Resource {
            api_version: "v1".to_string(),
            kind: "Pod".to_string(),
            metadata: meta_from(&item.metadata),
            spec: serialize_field!(item, spec),
            status: serialize_field!(item, status),
            data: None,
            type_: None,
        })
        .collect();

    Ok(ResourceList { items })
}

/// Fetch a single resource and return it serialized as YAML.
pub async fn get_resource_yaml(kind: &str, name: &str, namespace: &str) -> Result<String> {
    let client = get_client().await?;
    let (ar, cluster_scoped) = api_resource_for_kind(kind)?;

    let api = dynamic_api_for_resource(client, &ar, cluster_scoped, namespace);

    let mut obj = api.get(name).await?;

    // Strip managedFields -- verbose server-side apply noise with no user value
    obj.metadata.managed_fields = None;

    let yaml = serde_yaml::to_string(&obj)?;
    Ok(yaml)
}
