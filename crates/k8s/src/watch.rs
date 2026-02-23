use crate::resources::metadata_from;
use crate::types::{Resource, ResourceList, ResourceType};
use anyhow::Result;
use futures::TryStreamExt;
use kube::Client;
use kube::api::Api;
use kube::runtime::watcher::{self, Event};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

/// Minimum interval between sending updates to avoid flooding the UI
const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);

/// Start a watch stream for the given resource type and namespace.
/// Sends a full `ResourceList` through `tx` whenever the data changes.
/// Returns when the stream ends or when `cancelled` is set to true.
pub async fn watch_resources(
    client: &Client,
    resource_type: ResourceType,
    namespace: Option<String>,
    tx: Sender<ResourceList>,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    let ns = namespace.as_deref();
    match resource_type {
        ResourceType::Pods => {
            use k8s_openapi::api::core::v1::Pod;
            let api: Api<Pod> = ns_api(client, ns);
            watch_typed(api, "v1", "Pod", "pods", ns, &tx, &cancelled).await
        }
        ResourceType::Deployments => {
            use k8s_openapi::api::apps::v1::Deployment;
            let api: Api<Deployment> = ns_api(client, ns);
            watch_typed(
                api,
                "apps/v1",
                "Deployment",
                "deployments",
                ns,
                &tx,
                &cancelled,
            )
            .await
        }
        ResourceType::Services => {
            use k8s_openapi::api::core::v1::Service;
            let api: Api<Service> = ns_api(client, ns);
            watch_typed(api, "v1", "Service", "services", ns, &tx, &cancelled).await
        }
        ResourceType::ConfigMaps => {
            use k8s_openapi::api::core::v1::ConfigMap;
            let api: Api<ConfigMap> = ns_api(client, ns);
            watch_typed(api, "v1", "ConfigMap", "configmaps", ns, &tx, &cancelled).await
        }
        ResourceType::Secrets => {
            use k8s_openapi::api::core::v1::Secret;
            let api: Api<Secret> = ns_api(client, ns);
            watch_typed(api, "v1", "Secret", "secrets", ns, &tx, &cancelled).await
        }
        ResourceType::Ingresses => {
            use k8s_openapi::api::networking::v1::Ingress;
            let api: Api<Ingress> = ns_api(client, ns);
            watch_typed(
                api,
                "networking.k8s.io/v1",
                "Ingress",
                "ingresses",
                ns,
                &tx,
                &cancelled,
            )
            .await
        }
        ResourceType::StatefulSets => {
            use k8s_openapi::api::apps::v1::StatefulSet;
            let api: Api<StatefulSet> = ns_api(client, ns);
            watch_typed(
                api,
                "apps/v1",
                "StatefulSet",
                "statefulsets",
                ns,
                &tx,
                &cancelled,
            )
            .await
        }
        ResourceType::DaemonSets => {
            use k8s_openapi::api::apps::v1::DaemonSet;
            let api: Api<DaemonSet> = ns_api(client, ns);
            watch_typed(
                api,
                "apps/v1",
                "DaemonSet",
                "daemonsets",
                ns,
                &tx,
                &cancelled,
            )
            .await
        }
        ResourceType::Jobs => {
            use k8s_openapi::api::batch::v1::Job;
            let api: Api<Job> = ns_api(client, ns);
            watch_typed(api, "batch/v1", "Job", "jobs", ns, &tx, &cancelled).await
        }
        ResourceType::CronJobs => {
            use k8s_openapi::api::batch::v1::CronJob;
            let api: Api<CronJob> = ns_api(client, ns);
            watch_typed(api, "batch/v1", "CronJob", "cronjobs", ns, &tx, &cancelled).await
        }
        ResourceType::ReplicaSets => {
            use k8s_openapi::api::apps::v1::ReplicaSet;
            let api: Api<ReplicaSet> = ns_api(client, ns);
            watch_typed(
                api,
                "apps/v1",
                "ReplicaSet",
                "replicasets",
                ns,
                &tx,
                &cancelled,
            )
            .await
        }
        ResourceType::Nodes => {
            use k8s_openapi::api::core::v1::Node;
            let api: Api<Node> = Api::all(client.clone());
            watch_typed(api, "v1", "Node", "nodes", None, &tx, &cancelled).await
        }
        ResourceType::Namespaces => {
            use k8s_openapi::api::core::v1::Namespace;
            let api: Api<Namespace> = Api::all(client.clone());
            watch_typed(api, "v1", "Namespace", "namespaces", None, &tx, &cancelled).await
        }
        ResourceType::HorizontalPodAutoscalers => {
            use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
            let api: Api<HorizontalPodAutoscaler> = ns_api(client, ns);
            watch_typed(
                api,
                "autoscaling/v2",
                "HorizontalPodAutoscaler",
                "horizontalpodautoscalers",
                ns,
                &tx,
                &cancelled,
            )
            .await
        }
        ResourceType::VerticalPodAutoscalers => watch_vpa(client, ns, &tx, &cancelled).await,
    }
}

/// Create a namespaced or all-namespace Api
fn ns_api<K>(client: &Client, namespace: Option<&str>) -> Api<K>
where
    K: kube::Resource<DynamicType = (), Scope = k8s_openapi::NamespaceResourceScope>,
{
    match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    }
}

async fn watch_typed<K>(
    api: Api<K>,
    api_version: &str,
    kind: &str,
    type_name: &str,
    namespace: Option<&str>,
    tx: &Sender<ResourceList>,
    cancelled: &Arc<AtomicBool>,
) -> Result<()>
where
    K: kube::Resource<DynamicType = ()>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned
        + serde::Serialize
        + Send
        + 'static,
{
    let ns_owned = namespace.map(|s| s.to_string());
    let mut store: HashMap<String, Resource> = HashMap::new();
    let mut last_send = Instant::now() - WATCH_DEBOUNCE;
    let mut dirty = false;

    let stream = watcher::watcher(api, watcher::Config::default());
    futures::pin_mut!(stream);

    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }

        // If there are pending changes, wait at most until the debounce window expires
        let next = if dirty {
            let remaining = WATCH_DEBOUNCE.saturating_sub(last_send.elapsed());
            match tokio::time::timeout(remaining, stream.try_next()).await {
                Ok(result) => result?,
                Err(_) => None, // timeout — flush pending changes
            }
        } else {
            stream.try_next().await?
        };

        match next {
            Some(event) => {
                match event {
                    Event::Applied(obj) => {
                        let resource = obj_to_resource(&obj, api_version, kind);
                        store.insert(resource.metadata.uid.clone(), resource);
                    }
                    Event::Deleted(obj) => {
                        if let Some(uid) = obj.meta().uid.as_ref() {
                            store.remove(uid);
                        }
                    }
                    Event::Restarted(objects) => {
                        store.clear();
                        for obj in &objects {
                            let resource = obj_to_resource(obj, api_version, kind);
                            store.insert(resource.metadata.uid.clone(), resource);
                        }
                    }
                }
                dirty = true;

                // Send immediately if debounce window has passed
                if last_send.elapsed() >= WATCH_DEBOUNCE {
                    let list = ResourceList {
                        resource_type: type_name.to_string(),
                        namespace: ns_owned.clone(),
                        items: store.values().cloned().collect(),
                    };
                    if tx.send(list).is_err() {
                        return Ok(());
                    }
                    last_send = Instant::now();
                    dirty = false;
                }
            }
            None => {
                // Stream ended or timeout — flush pending changes
                if dirty {
                    let list = ResourceList {
                        resource_type: type_name.to_string(),
                        namespace: ns_owned.clone(),
                        items: store.values().cloned().collect(),
                    };
                    if tx.send(list).is_err() {
                        return Ok(());
                    }
                    last_send = Instant::now();
                    dirty = false;
                }
                // If it was a stream end (not a timeout), break
                if !dirty && last_send.elapsed() >= WATCH_DEBOUNCE {
                    break;
                }
            }
        }
    }

    Ok(())
}

fn obj_to_resource<K>(obj: &K, api_version: &str, kind: &str) -> Resource
where
    K: kube::Resource<DynamicType = ()> + serde::Serialize,
{
    let metadata = metadata_from(obj, obj.meta());

    let value = serde_json::to_value(obj).unwrap_or_default();

    Resource {
        api_version: api_version.to_string(),
        kind: kind.to_string(),
        metadata,
        spec: value.get("spec").cloned(),
        status: value.get("status").cloned(),
        data: value.get("data").cloned(),
        type_: value
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

async fn watch_vpa(
    client: &Client,
    namespace: Option<&str>,
    tx: &Sender<ResourceList>,
    cancelled: &Arc<AtomicBool>,
) -> Result<()> {
    use kube::api::DynamicObject;
    use kube::discovery::ApiResource;

    let ar = ApiResource {
        group: "autoscaling.k8s.io".to_string(),
        version: "v1".to_string(),
        kind: "VerticalPodAutoscaler".to_string(),
        api_version: "autoscaling.k8s.io/v1".to_string(),
        plural: "verticalpodautoscalers".to_string(),
    };

    let api: Api<DynamicObject> = match namespace {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };

    let ns_owned = namespace.map(|s| s.to_string());
    let mut store: HashMap<String, Resource> = HashMap::new();
    let mut last_send = Instant::now() - WATCH_DEBOUNCE;
    let mut dirty = false;

    let stream = watcher::watcher(api, watcher::Config::default());
    futures::pin_mut!(stream);

    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }

        let next = if dirty {
            let remaining = WATCH_DEBOUNCE.saturating_sub(last_send.elapsed());
            match tokio::time::timeout(remaining, stream.try_next()).await {
                Ok(result) => result?,
                Err(_) => None,
            }
        } else {
            stream.try_next().await?
        };

        match next {
            Some(event) => {
                match event {
                    Event::Applied(obj) => {
                        let resource = dynamic_to_resource(&obj);
                        store.insert(resource.metadata.uid.clone(), resource);
                    }
                    Event::Deleted(obj) => {
                        if let Some(uid) = obj.metadata.uid.as_ref() {
                            store.remove(uid);
                        }
                    }
                    Event::Restarted(objects) => {
                        store.clear();
                        for obj in &objects {
                            let resource = dynamic_to_resource(obj);
                            store.insert(resource.metadata.uid.clone(), resource);
                        }
                    }
                }
                dirty = true;

                if last_send.elapsed() >= WATCH_DEBOUNCE {
                    let list = ResourceList {
                        resource_type: "verticalpodautoscalers".to_string(),
                        namespace: ns_owned.clone(),
                        items: store.values().cloned().collect(),
                    };
                    if tx.send(list).is_err() {
                        return Ok(());
                    }
                    last_send = Instant::now();
                    dirty = false;
                }
            }
            None => {
                if dirty {
                    let list = ResourceList {
                        resource_type: "verticalpodautoscalers".to_string(),
                        namespace: ns_owned.clone(),
                        items: store.values().cloned().collect(),
                    };
                    if tx.send(list).is_err() {
                        return Ok(());
                    }
                    last_send = Instant::now();
                    dirty = false;
                }
                if !dirty && last_send.elapsed() >= WATCH_DEBOUNCE {
                    break;
                }
            }
        }
    }

    Ok(())
}

fn dynamic_to_resource(obj: &kube::api::DynamicObject) -> Resource {
    use crate::types::{OwnerReference, ResourceMetadata};

    let meta = &obj.metadata;
    let metadata = ResourceMetadata {
        name: meta.name.clone().unwrap_or_default(),
        namespace: meta.namespace.clone(),
        uid: meta.uid.clone().unwrap_or_default(),
        resource_version: meta.resource_version.clone().unwrap_or_default(),
        labels: meta.labels.clone(),
        annotations: meta.annotations.clone(),
        creation_timestamp: meta.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
        owner_references: meta.owner_references.as_ref().map(|refs| {
            refs.iter()
                .map(|r| OwnerReference {
                    api_version: r.api_version.clone(),
                    kind: r.kind.clone(),
                    name: r.name.clone(),
                    uid: r.uid.clone(),
                })
                .collect()
        }),
    };

    Resource {
        api_version: "autoscaling.k8s.io/v1".to_string(),
        kind: "VerticalPodAutoscaler".to_string(),
        metadata,
        spec: obj.data.get("spec").cloned(),
        status: obj.data.get("status").cloned(),
        data: None,
        type_: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use kube::api::DynamicObject;
    use serde_json::json;

    #[test]
    fn obj_to_resource_extracts_standard_sections() {
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("pod-a".to_string()),
                namespace: Some("default".to_string()),
                uid: Some("uid-a".to_string()),
                ..Default::default()
            },
            spec: Some(Default::default()),
            status: Some(Default::default()),
        };

        let resource = obj_to_resource(&pod, "v1", "Pod");

        assert_eq!(resource.api_version, "v1");
        assert_eq!(resource.kind, "Pod");
        assert_eq!(resource.metadata.name, "pod-a");
        assert_eq!(resource.metadata.uid, "uid-a");
        assert!(resource.spec.is_some());
        assert!(resource.status.is_some());
        assert!(resource.data.is_none());
    }

    #[test]
    fn dynamic_to_resource_maps_vpa_shape() {
        let obj = DynamicObject {
            types: None,
            metadata: ObjectMeta {
                name: Some("vpa-a".to_string()),
                namespace: Some("ns-a".to_string()),
                uid: Some("uid-vpa".to_string()),
                ..Default::default()
            },
            data: json!({
                "spec": { "targetRef": { "kind": "Deployment", "name": "web" } },
                "status": { "recommendation": {} }
            }),
        };

        let resource = dynamic_to_resource(&obj);

        assert_eq!(resource.api_version, "autoscaling.k8s.io/v1");
        assert_eq!(resource.kind, "VerticalPodAutoscaler");
        assert_eq!(resource.metadata.name, "vpa-a");
        assert_eq!(resource.metadata.namespace.as_deref(), Some("ns-a"));
        assert!(resource.spec.is_some());
        assert!(resource.status.is_some());
        assert!(resource.data.is_none());
    }
}
