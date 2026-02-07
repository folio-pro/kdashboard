use crate::resources::metadata_from;
use crate::types::{Resource, ResourceList, ResourceType};
use anyhow::Result;
use futures::TryStreamExt;
use kube::api::Api;
use kube::runtime::watcher::{self, Event};
use kube::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

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
            watch_typed(api, "apps/v1", "Deployment", "deployments", ns, &tx, &cancelled).await
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
            watch_typed(api, "networking.k8s.io/v1", "Ingress", "ingresses", ns, &tx, &cancelled).await
        }
        ResourceType::StatefulSets => {
            use k8s_openapi::api::apps::v1::StatefulSet;
            let api: Api<StatefulSet> = ns_api(client, ns);
            watch_typed(api, "apps/v1", "StatefulSet", "statefulsets", ns, &tx, &cancelled).await
        }
        ResourceType::DaemonSets => {
            use k8s_openapi::api::apps::v1::DaemonSet;
            let api: Api<DaemonSet> = ns_api(client, ns);
            watch_typed(api, "apps/v1", "DaemonSet", "daemonsets", ns, &tx, &cancelled).await
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
            watch_typed(api, "apps/v1", "ReplicaSet", "replicasets", ns, &tx, &cancelled).await
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

    let stream = watcher::watcher(api, watcher::Config::default());
    futures::pin_mut!(stream);

    while let Some(event) = stream.try_next().await? {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }

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

        let list = ResourceList {
            resource_type: type_name.to_string(),
            namespace: ns_owned.clone(),
            items: store.values().cloned().collect(),
        };
        if tx.send(list).is_err() {
            return Ok(()); // Receiver dropped
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
