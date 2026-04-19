use anyhow::Result;
use kube::api::{ApiResource, DynamicObject};
use kube::Api;

use super::pod::diagnose_pod;
use super::types::{DiagnosticIssue, DiagnosticResult};
use super::workload::diagnose_deployment;
use crate::k8s::client::get_client;
use crate::k8s::resources::get_resource_events;

pub async fn diagnose_resource(
    kind: &str,
    name: &str,
    namespace: &str,
) -> Result<DiagnosticResult> {
    let client = get_client().await?;
    let now = chrono::Utc::now().to_rfc3339();

    // Map kind to resource type and API resource in a single match
    let kind_lower = kind.to_lowercase();
    let (resource_type, ar) = match kind_lower.as_str() {
        "pod" => (
            "pods",
            ApiResource::erase::<k8s_openapi::api::core::v1::Pod>(&()),
        ),
        "deployment" => (
            "deployments",
            ApiResource::erase::<k8s_openapi::api::apps::v1::Deployment>(&()),
        ),
        "statefulset" => (
            "statefulsets",
            ApiResource::erase::<k8s_openapi::api::apps::v1::StatefulSet>(&()),
        ),
        "daemonset" => (
            "daemonsets",
            ApiResource::erase::<k8s_openapi::api::apps::v1::DaemonSet>(&()),
        ),
        "job" => (
            "jobs",
            ApiResource::erase::<k8s_openapi::api::batch::v1::Job>(&()),
        ),
        "replicaset" => (
            "replicasets",
            ApiResource::erase::<k8s_openapi::api::apps::v1::ReplicaSet>(&()),
        ),
        _ => (
            "pods",
            ApiResource::erase::<k8s_openapi::api::core::v1::Pod>(&()),
        ),
    };

    // Fetch the specific resource
    let obj = {
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
        let resource: DynamicObject = api.get(name).await?;
        serde_json::to_value(resource)?
    };

    let uid = obj
        .get("metadata")
        .and_then(|m| m.get("uid"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Run diagnostics based on kind
    let mut issues = match kind.to_lowercase().as_str() {
        "pod" => diagnose_pod(&obj),
        "deployment" => diagnose_deployment(&obj),
        "statefulset" | "daemonset" => diagnose_deployment(&obj), // similar condition checks
        _ => vec![],
    };

    // Check events for additional signals
    if let Ok(events) = get_resource_events(resource_type, name, namespace).await {
        for event in &events {
            if event.type_.as_deref() == Some("Warning") {
                let reason = event.reason.as_deref().unwrap_or("");
                let message = event.message.as_deref().unwrap_or("");
                let count = event.count.unwrap_or(1);

                // Only flag events that occurred multiple times
                if count >= 3 {
                    let already_covered = issues
                        .iter()
                        .any(|i| i.title.contains(reason) || i.detail.contains(reason));

                    if !already_covered {
                        issues.push(DiagnosticIssue {
                            severity: "warning".into(),
                            category: "crash".into(),
                            title: format!("Repeated warning event: {}", reason),
                            detail: format!("{}. Occurred {} times.", message, count),
                            suggestion: "Investigate the event details and related logs.".into(),
                        });
                    }
                }
            }
        }
    }

    // Determine overall health
    let health = if issues.iter().any(|i| i.severity == "critical") {
        "unhealthy"
    } else if issues.iter().any(|i| i.severity == "warning") {
        "degraded"
    } else {
        "healthy"
    };

    Ok(DiagnosticResult {
        resource_uid: uid,
        resource_kind: kind.to_string(),
        resource_name: name.to_string(),
        health: health.to_string(),
        issues,
        checked_at: now,
    })
}
