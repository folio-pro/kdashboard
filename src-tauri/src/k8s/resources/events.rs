use anyhow::Result;
use k8s_openapi::api::core::v1::Event;
use kube::api::ListParams;
use kube::Api;

use super::types::EventItem;
use crate::k8s::client::get_client;

/// Get events for a specific resource by name and type.
pub async fn get_resource_events(
    resource_type: &str,
    name: &str,
    namespace: &str,
) -> Result<Vec<EventItem>> {
    // Map plural resource type to the involved object kind expected by K8s events.
    let kind = match resource_type {
        "pods" => "Pod",
        "deployments" => "Deployment",
        "services" => "Service",
        "statefulsets" => "StatefulSet",
        "daemonsets" => "DaemonSet",
        "jobs" => "Job",
        "cronjobs" => "CronJob",
        "replicasets" => "ReplicaSet",
        "configmaps" => "ConfigMap",
        "secrets" => "Secret",
        "ingresses" => "Ingress",
        "nodes" => "Node",
        "namespaces" => "Namespace",
        "hpa" => "HorizontalPodAutoscaler",
        "networkpolicies" => "NetworkPolicy",
        "persistentvolumes" => "PersistentVolume",
        "persistentvolumeclaims" => "PersistentVolumeClaim",
        "storageclasses" => "StorageClass",
        "roles" => "Role",
        "rolebindings" => "RoleBinding",
        "clusterroles" => "ClusterRole",
        "clusterrolebindings" => "ClusterRoleBinding",
        "resourcequotas" => "ResourceQuota",
        "limitranges" => "LimitRange",
        "poddisruptionbudgets" => "PodDisruptionBudget",
        other => other,
    };

    let field_selector = format!("involvedObject.name={},involvedObject.kind={}", name, kind);

    let ns = if namespace.is_empty() {
        None
    } else {
        Some(namespace.to_string())
    };

    get_events(ns, Some(field_selector)).await
}

/// List events, optionally filtered by namespace and field selector.
pub async fn get_events(
    namespace: Option<String>,
    field_selector: Option<String>,
) -> Result<Vec<EventItem>> {
    let client = get_client().await?;

    let api: Api<Event> = match namespace {
        Some(ref ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let mut lp = ListParams::default();
    if let Some(ref fs) = field_selector {
        lp = lp.fields(fs);
    }

    let list = api.list(&lp).await?;

    let events: Vec<EventItem> = list
        .items
        .iter()
        .map(|e| EventItem {
            name: e.metadata.name.clone(),
            namespace: e.metadata.namespace.clone(),
            reason: e.reason.clone(),
            message: e.message.clone(),
            type_: e.type_.clone(),
            involved_object: serde_json::to_value(&e.involved_object).ok(),
            first_timestamp: e.first_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
            last_timestamp: e.last_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
            count: e.count,
            source: e.source.as_ref().and_then(|s| serde_json::to_value(s).ok()),
        })
        .collect();

    Ok(events)
}
