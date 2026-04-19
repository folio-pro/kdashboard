use anyhow::Result;
use futures::StreamExt;
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher;
use kube::Api;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tokio::sync::Mutex;

use super::client::get_client;
use super::resources::{meta_from, Resource, ResourceMetadata};

// ---------------------------------------------------------------------------
// Global state for the active watcher
// ---------------------------------------------------------------------------

static WATCHER_ABORT: std::sync::OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> =
    std::sync::OnceLock::new();
static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

fn watcher_handle() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    WATCHER_ABORT.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Event payload sent to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WatchEvent {
    /// "Applied" or "Deleted"
    pub event_type: String,
    /// The resource type being watched (e.g. "pods")
    pub resource_type: String,
    /// The affected resource (full data for Applied, minimal for Deleted)
    pub resource: Resource,
}

// ---------------------------------------------------------------------------
// Map plural resource type to ApiResource + scope info
// ---------------------------------------------------------------------------

fn api_resource_for_type(resource_type: &str) -> Result<(ApiResource, bool, bool)> {
    // Returns (ApiResource, cluster_scoped, has_namespace_scope)
    let (group, version, kind, plural, cluster_scoped) = match resource_type {
        "pods" => ("", "v1", "Pod", "pods", false),
        "deployments" => ("apps", "v1", "Deployment", "deployments", false),
        "services" => ("", "v1", "Service", "services", false),
        "configmaps" => ("", "v1", "ConfigMap", "configmaps", false),
        "secrets" => ("", "v1", "Secret", "secrets", false),
        "ingresses" => ("networking.k8s.io", "v1", "Ingress", "ingresses", false),
        "statefulsets" => ("apps", "v1", "StatefulSet", "statefulsets", false),
        "daemonsets" => ("apps", "v1", "DaemonSet", "daemonsets", false),
        "jobs" => ("batch", "v1", "Job", "jobs", false),
        "cronjobs" => ("batch", "v1", "CronJob", "cronjobs", false),
        "replicasets" => ("apps", "v1", "ReplicaSet", "replicasets", false),
        "nodes" => ("", "v1", "Node", "nodes", true),
        "namespaces" => ("", "v1", "Namespace", "namespaces", true),
        "hpa" => (
            "autoscaling",
            "v2",
            "HorizontalPodAutoscaler",
            "horizontalpodautoscalers",
            false,
        ),
        "networkpolicies" => (
            "networking.k8s.io",
            "v1",
            "NetworkPolicy",
            "networkpolicies",
            false,
        ),
        "persistentvolumes" => ("", "v1", "PersistentVolume", "persistentvolumes", true),
        "persistentvolumeclaims" => (
            "",
            "v1",
            "PersistentVolumeClaim",
            "persistentvolumeclaims",
            false,
        ),
        "storageclasses" => (
            "storage.k8s.io",
            "v1",
            "StorageClass",
            "storageclasses",
            true,
        ),
        "roles" => ("rbac.authorization.k8s.io", "v1", "Role", "roles", false),
        "rolebindings" => (
            "rbac.authorization.k8s.io",
            "v1",
            "RoleBinding",
            "rolebindings",
            false,
        ),
        "clusterroles" => (
            "rbac.authorization.k8s.io",
            "v1",
            "ClusterRole",
            "clusterroles",
            true,
        ),
        "clusterrolebindings" => (
            "rbac.authorization.k8s.io",
            "v1",
            "ClusterRoleBinding",
            "clusterrolebindings",
            true,
        ),
        "resourcequotas" => ("", "v1", "ResourceQuota", "resourcequotas", false),
        "limitranges" => ("", "v1", "LimitRange", "limitranges", false),
        "poddisruptionbudgets" => (
            "policy",
            "v1",
            "PodDisruptionBudget",
            "poddisruptionbudgets",
            false,
        ),
        other => {
            return Err(anyhow::anyhow!(
                "Unknown resource type for watch: {}",
                other
            ))
        }
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
            api_version: api_version.clone(),
            kind: kind.to_string(),
            plural: plural.to_string(),
        },
        cluster_scoped,
        !cluster_scoped,
    ))
}

// ---------------------------------------------------------------------------
// Convert DynamicObject to our Resource struct
// ---------------------------------------------------------------------------

fn dynamic_to_resource(mut obj: DynamicObject, api_version: &str, kind: &str) -> Resource {
    // Take ownership of fields from DynamicObject.data (already a serde_json::Value map)
    // to avoid deep cloning large spec/status JSON trees.
    let type_ = obj
        .data
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut map = obj.data.as_object_mut();
    Resource {
        api_version: api_version.to_string(),
        kind: kind.to_string(),
        metadata: meta_from(&obj.metadata),
        spec: map.as_mut().and_then(|m| m.remove("spec")),
        status: map.as_mut().and_then(|m| m.remove("status")),
        data: map.as_mut().and_then(|m| m.remove("data")),
        type_,
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Start watching resources of the given type. Emits "resource-watch-event" Tauri events.
pub async fn start_watch(
    resource_type: String,
    namespace: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    // Stop any existing watcher first
    stop_watch().await;

    let client = get_client().await?;
    let (ar, cluster_scoped, _) = api_resource_for_type(&resource_type)?;

    let api: Api<DynamicObject> = if cluster_scoped {
        Api::all_with(client, &ar)
    } else {
        match namespace {
            Some(ref ns) => Api::namespaced_with(client, ns, &ar),
            None => Api::all_with(client, &ar),
        }
    };

    let api_version = ar.api_version.clone();
    let kind = ar.kind.clone();
    let rt = resource_type.clone();

    WATCHER_RUNNING.store(true, Ordering::SeqCst);

    let handle = tokio::spawn(async move {
        let watcher_config = watcher::Config::default();
        let mut stream = std::pin::pin!(watcher(api, watcher_config));
        let mut is_initial_sync = true;

        while let Some(event) = stream.next().await {
            // NOTE: This check-then-act on an AtomicBool is intentionally non-atomic.
            // The worst case is one extra iteration before the loop observes the stop
            // signal, which is benign because stop_watch() also calls handle.abort()
            // to forcefully terminate this task.  No data-corruption risk exists.
            if !WATCHER_RUNNING.load(Ordering::SeqCst) {
                break;
            }

            match event {
                Ok(watcher::Event::Apply(obj)) => {
                    let resource = dynamic_to_resource(obj, &api_version, &kind);
                    let watch_event = WatchEvent {
                        event_type: "Applied".to_string(),
                        resource_type: rt.clone(),
                        resource,
                    };
                    let _ = app_handle.emit("resource-watch-event", &watch_event);
                }
                Ok(watcher::Event::Delete(obj)) => {
                    let resource = dynamic_to_resource(obj, &api_version, &kind);
                    let watch_event = WatchEvent {
                        event_type: "Deleted".to_string(),
                        resource_type: rt.clone(),
                        resource,
                    };
                    let _ = app_handle.emit("resource-watch-event", &watch_event);
                }
                Ok(watcher::Event::Init) | Ok(watcher::Event::InitApply(_)) => {
                    // Skip initial list items — we already have them from loadResources.
                    // This also avoids format mismatches (e.g. Secrets need special
                    // base64 handling that only list_resources performs).
                }
                Ok(watcher::Event::InitDone) => {
                    if is_initial_sync {
                        // First sync done; nothing to do, we have the data.
                        is_initial_sync = false;
                    } else {
                        // Re-sync after a disconnect: tell frontend to do a full refresh
                        // so it picks up any changes we missed during the gap.
                        let watch_event = WatchEvent {
                            event_type: "Resync".to_string(),
                            resource_type: rt.clone(),
                            resource: Resource {
                                api_version: String::new(),
                                kind: String::new(),
                                metadata: ResourceMetadata::default(),
                                spec: None,
                                status: None,
                                data: None,
                                type_: None,
                            },
                        };
                        let _ = app_handle.emit("resource-watch-event", &watch_event);
                    }
                }
                Err(e) => {
                    tracing::warn!("Watch error for {}: {}", rt, e);
                    // The watcher will automatically try to recover via re-list
                }
            }
        }

        tracing::info!("Watch stream ended for {}", rt);
    });

    let mut guard = watcher_handle().lock().await;
    *guard = Some(handle);

    Ok(())
}

/// Stop the active watcher.
pub async fn stop_watch() {
    WATCHER_RUNNING.store(false, Ordering::SeqCst);
    let mut guard = watcher_handle().lock().await;
    if let Some(handle) = guard.take() {
        handle.abort();
        let _ = handle.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_event_serializes() {
        let event = WatchEvent {
            event_type: "Applied".to_string(),
            resource_type: "pods".to_string(),
            resource: Resource {
                api_version: "v1".to_string(),
                kind: "Pod".to_string(),
                metadata: ResourceMetadata::default(),
                spec: None,
                status: None,
                data: None,
                type_: None,
            },
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event_type"], "Applied");
        assert_eq!(json["resource_type"], "pods");
        assert_eq!(json["resource"]["kind"], "Pod");
    }

    #[test]
    fn api_resource_for_type_resolves_all_resource_types() {
        let types = vec![
            "pods",
            "deployments",
            "services",
            "configmaps",
            "secrets",
            "ingresses",
            "statefulsets",
            "daemonsets",
            "jobs",
            "cronjobs",
            "replicasets",
            "nodes",
            "namespaces",
            "hpa",
            "networkpolicies",
            "persistentvolumes",
            "persistentvolumeclaims",
            "storageclasses",
            "roles",
            "rolebindings",
            "clusterroles",
            "clusterrolebindings",
            "resourcequotas",
            "limitranges",
            "poddisruptionbudgets",
        ];
        for rt in types {
            let result = api_resource_for_type(rt);
            assert!(result.is_ok(), "Failed to resolve resource type: {}", rt);
        }
    }

    #[test]
    fn api_resource_for_type_returns_error_for_unknown() {
        assert!(api_resource_for_type("foobar").is_err());
    }

    #[test]
    fn api_resource_for_type_cluster_scoped_flags() {
        let cluster_scoped = vec![
            "nodes",
            "namespaces",
            "persistentvolumes",
            "storageclasses",
            "clusterroles",
            "clusterrolebindings",
        ];
        let namespaced = vec!["pods", "deployments", "services", "configmaps", "secrets"];

        for rt in cluster_scoped {
            let (_, is_cluster, _) = api_resource_for_type(rt).unwrap();
            assert!(is_cluster, "{} should be cluster-scoped", rt);
        }

        for rt in namespaced {
            let (_, is_cluster, _) = api_resource_for_type(rt).unwrap();
            assert!(!is_cluster, "{} should be namespaced", rt);
        }
    }

    #[test]
    fn api_resource_for_type_api_version_format() {
        // Core resources
        let (ar, _, _) = api_resource_for_type("pods").unwrap();
        assert_eq!(ar.api_version, "v1");

        // Grouped resources
        let (ar, _, _) = api_resource_for_type("deployments").unwrap();
        assert_eq!(ar.api_version, "apps/v1");
    }

    #[test]
    fn dynamic_to_resource_extracts_fields() {
        let mut data = serde_json::Map::new();
        data.insert("spec".to_string(), serde_json::json!({"replicas": 3}));
        data.insert("status".to_string(), serde_json::json!({"ready": 3}));
        data.insert("type".to_string(), serde_json::json!("Opaque"));

        let obj = DynamicObject {
            metadata: kube::api::ObjectMeta {
                name: Some("test".into()),
                namespace: Some("default".into()),
                ..Default::default()
            },
            types: None,
            data: serde_json::Value::Object(data),
        };

        let resource = dynamic_to_resource(obj, "v1", "Secret");
        assert_eq!(resource.kind, "Secret");
        assert_eq!(resource.api_version, "v1");
        assert_eq!(resource.metadata.name.as_deref(), Some("test"));
        assert!(resource.spec.is_some());
        assert!(resource.status.is_some());
        assert_eq!(resource.type_.as_deref(), Some("Opaque"));
    }

    #[test]
    fn dynamic_to_resource_handles_missing_fields() {
        let obj = DynamicObject {
            metadata: kube::api::ObjectMeta::default(),
            types: None,
            data: serde_json::json!({}),
        };

        let resource = dynamic_to_resource(obj, "apps/v1", "Deployment");
        assert_eq!(resource.kind, "Deployment");
        assert!(resource.spec.is_none());
        assert!(resource.status.is_none());
        assert!(resource.data.is_none());
        assert!(resource.type_.is_none());
    }

    // -----------------------------------------------------------------------
    // api_resource_for_type — detailed field validation
    // -----------------------------------------------------------------------

    #[test]
    fn api_resource_for_type_pods_fields() {
        let (ar, cluster_scoped, has_ns) = api_resource_for_type("pods").unwrap();
        assert_eq!(ar.group, "");
        assert_eq!(ar.version, "v1");
        assert_eq!(ar.api_version, "v1");
        assert_eq!(ar.kind, "Pod");
        assert_eq!(ar.plural, "pods");
        assert!(!cluster_scoped);
        assert!(has_ns);
    }

    #[test]
    fn api_resource_for_type_deployments_fields() {
        let (ar, cluster_scoped, has_ns) = api_resource_for_type("deployments").unwrap();
        assert_eq!(ar.group, "apps");
        assert_eq!(ar.version, "v1");
        assert_eq!(ar.api_version, "apps/v1");
        assert_eq!(ar.kind, "Deployment");
        assert_eq!(ar.plural, "deployments");
        assert!(!cluster_scoped);
        assert!(has_ns);
    }

    #[test]
    fn api_resource_for_type_services_fields() {
        let (ar, cluster_scoped, has_ns) = api_resource_for_type("services").unwrap();
        assert_eq!(ar.group, "");
        assert_eq!(ar.version, "v1");
        assert_eq!(ar.api_version, "v1");
        assert_eq!(ar.kind, "Service");
        assert_eq!(ar.plural, "services");
        assert!(!cluster_scoped);
        assert!(has_ns);
    }

    #[test]
    fn api_resource_for_type_configmaps_fields() {
        let (ar, _, _) = api_resource_for_type("configmaps").unwrap();
        assert_eq!(ar.kind, "ConfigMap");
        assert_eq!(ar.api_version, "v1");
    }

    #[test]
    fn api_resource_for_type_secrets_fields() {
        let (ar, _, _) = api_resource_for_type("secrets").unwrap();
        assert_eq!(ar.kind, "Secret");
        assert_eq!(ar.api_version, "v1");
    }

    #[test]
    fn api_resource_for_type_ingresses_fields() {
        let (ar, _, _) = api_resource_for_type("ingresses").unwrap();
        assert_eq!(ar.kind, "Ingress");
        assert_eq!(ar.group, "networking.k8s.io");
        assert_eq!(ar.api_version, "networking.k8s.io/v1");
    }

    #[test]
    fn api_resource_for_type_hpa_fields() {
        let (ar, cluster_scoped, _) = api_resource_for_type("hpa").unwrap();
        assert_eq!(ar.kind, "HorizontalPodAutoscaler");
        assert_eq!(ar.group, "autoscaling");
        assert_eq!(ar.version, "v2");
        assert_eq!(ar.api_version, "autoscaling/v2");
        assert!(!cluster_scoped);
    }

    #[test]
    fn api_resource_for_type_all_return_valid_api_resource() {
        // Verify every supported type returns a valid ApiResource with
        // non-empty kind, version, plural, and api_version fields.
        let types = vec![
            "pods",
            "deployments",
            "services",
            "configmaps",
            "secrets",
            "ingresses",
            "statefulsets",
            "daemonsets",
            "jobs",
            "cronjobs",
            "replicasets",
            "nodes",
            "namespaces",
            "hpa",
            "networkpolicies",
            "persistentvolumes",
            "persistentvolumeclaims",
            "storageclasses",
            "roles",
            "rolebindings",
            "clusterroles",
            "clusterrolebindings",
            "resourcequotas",
            "limitranges",
            "poddisruptionbudgets",
        ];
        for rt in &types {
            let (ar, _, _) =
                api_resource_for_type(rt).unwrap_or_else(|_| panic!("Failed to resolve: {}", rt));
            assert!(!ar.kind.is_empty(), "kind empty for {}", rt);
            assert!(!ar.version.is_empty(), "version empty for {}", rt);
            assert!(!ar.plural.is_empty(), "plural empty for {}", rt);
            assert!(!ar.api_version.is_empty(), "api_version empty for {}", rt);
        }
    }

    #[test]
    fn api_resource_for_type_cluster_vs_namespaced_inverse() {
        // has_namespace_scope should always be the inverse of cluster_scoped
        let types = vec![
            "pods",
            "deployments",
            "nodes",
            "namespaces",
            "persistentvolumes",
            "storageclasses",
            "clusterroles",
            "clusterrolebindings",
            "services",
            "configmaps",
        ];
        for rt in &types {
            let (_, cluster_scoped, has_ns) = api_resource_for_type(rt).unwrap();
            assert_eq!(
                cluster_scoped, !has_ns,
                "{}: cluster_scoped={} but has_ns={} — must be inverses",
                rt, cluster_scoped, has_ns
            );
        }
    }
}
