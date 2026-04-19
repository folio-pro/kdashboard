use anyhow::Result;
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
use kube::Api;

use super::helpers::vpa_api_resource;
use crate::k8s::client::get_client;

// ---------------------------------------------------------------------------
// Lightweight resource count (metadata-only, no spec/status serialization)
// ---------------------------------------------------------------------------

macro_rules! count_namespaced_resource {
    ($type:ty, $client:expr, $namespace:expr) => {{
        let api: Api<$type> = match $namespace {
            Some(ref ns) => Api::namespaced($client.clone(), ns),
            None => Api::all($client.clone()),
        };
        let list = api.list(&ListParams::default()).await?;
        Ok(list.items.len() as u32)
    }};
}

macro_rules! count_cluster_resource {
    ($type:ty, $client:expr) => {{
        let api: Api<$type> = Api::all($client.clone());
        let list = api.list(&ListParams::default()).await?;
        Ok(list.items.len() as u32)
    }};
}

async fn count_resources_with_client(
    resource_type: &str,
    namespace: Option<String>,
    client: kube::Client,
) -> Result<u32> {
    match resource_type {
        "pods" => count_namespaced_resource!(Pod, client, namespace),
        "deployments" => count_namespaced_resource!(Deployment, client, namespace),
        "services" => count_namespaced_resource!(Service, client, namespace),
        "configmaps" => count_namespaced_resource!(ConfigMap, client, namespace),
        "secrets" => count_namespaced_resource!(Secret, client, namespace),
        "ingresses" => count_namespaced_resource!(Ingress, client, namespace),
        "statefulsets" => count_namespaced_resource!(StatefulSet, client, namespace),
        "daemonsets" => count_namespaced_resource!(DaemonSet, client, namespace),
        "jobs" => count_namespaced_resource!(Job, client, namespace),
        "cronjobs" => count_namespaced_resource!(CronJob, client, namespace),
        "replicasets" => count_namespaced_resource!(ReplicaSet, client, namespace),
        "nodes" => count_cluster_resource!(Node, client),
        "namespaces" => count_cluster_resource!(Namespace, client),
        "hpa" => count_namespaced_resource!(HorizontalPodAutoscaler, client, namespace),
        "networkpolicies" => count_namespaced_resource!(NetworkPolicy, client, namespace),
        "persistentvolumes" => count_cluster_resource!(PersistentVolume, client),
        "persistentvolumeclaims" => {
            count_namespaced_resource!(PersistentVolumeClaim, client, namespace)
        }
        "storageclasses" => count_cluster_resource!(StorageClass, client),
        "roles" => count_namespaced_resource!(Role, client, namespace),
        "rolebindings" => count_namespaced_resource!(RoleBinding, client, namespace),
        "clusterroles" => count_cluster_resource!(ClusterRole, client),
        "clusterrolebindings" => count_cluster_resource!(ClusterRoleBinding, client),
        "resourcequotas" => count_namespaced_resource!(ResourceQuota, client, namespace),
        "limitranges" => count_namespaced_resource!(LimitRange, client, namespace),
        "poddisruptionbudgets" => {
            count_namespaced_resource!(PodDisruptionBudget, client, namespace)
        }
        "vpa" => {
            let ar = vpa_api_resource();
            let api: Api<DynamicObject> = match namespace {
                Some(ref ns) => Api::namespaced_with(client.clone(), ns, &ar),
                None => Api::all_with(client.clone(), &ar),
            };
            match api.list(&ListParams::default()).await {
                Ok(list) => Ok(list.items.len() as u32),
                Err(_) => Ok(0), // VPA CRD may not be installed
            }
        }
        _ => Ok(0),
    }
}

/// Get counts for multiple resource types in a single call.
pub async fn get_resource_counts(
    resource_types: Vec<String>,
    namespace: Option<String>,
) -> Result<std::collections::HashMap<String, u32>> {
    let client = get_client().await?;
    let futures: Vec<_> = resource_types
        .into_iter()
        .map(|rt| {
            let ns = namespace.clone();
            let c = client.clone();
            async move {
                let count = count_resources_with_client(&rt, ns, c).await.unwrap_or(0);
                (rt, count)
            }
        })
        .collect();

    Ok(futures::future::join_all(futures)
        .await
        .into_iter()
        .collect())
}
