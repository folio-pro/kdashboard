use super::StrErr;
use crate::k8s;

use k8s::cost::{CostOverview, NodeCostInfo, NodeMetricsInfo};
use k8s::crd::{CrdGroup, CrdInfo, CrdResourceList, StatusCondition};
use k8s::diagnostics::DiagnosticResult;
use k8s::portforward::PortForwardResult;
use k8s::resources::{EventItem, ResourceList, RevisionInfo};
use k8s::security::{ImageScanResult, SecurityOverview};
use k8s::topology::TopologyGraph;

// ===========================================================================
// Connection
// ===========================================================================

#[tauri::command]
#[tracing::instrument]
pub async fn get_contexts() -> Result<Vec<String>, String> {
    k8s::context::list_contexts().str_err()
}

#[tauri::command]
pub async fn get_current_context() -> Result<String, String> {
    k8s::context::get_current_context().str_err()
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_namespaces() -> Result<Vec<String>, String> {
    k8s::context::list_namespaces().await.str_err()
}

#[tauri::command]
#[tracing::instrument]
pub async fn switch_context(context: String) -> Result<(), String> {
    k8s::context::set_context(&context).str_err()?;
    crate::clear_k8s_version_cache().await;
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub async fn check_connection() -> Result<bool, String> {
    match k8s::client::get_client().await {
        Ok(client) => {
            use kube::api::ListParams;
            use kube::Api;
            let ns_api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client);
            match ns_api.list(&ListParams::default().limit(1)).await {
                Ok(_) => Ok(true),
                Err(e) => Err(format!("Cluster unreachable: {}", e)),
            }
        }
        Err(e) => Err(format!("Failed to create client: {}", e)),
    }
}

// ===========================================================================
// Resources
// ===========================================================================

#[tauri::command]
#[tracing::instrument(skip_all, fields(resource_type, ns = ?namespace))]
pub async fn list_resources(
    resource_type: String,
    namespace: Option<String>,
) -> Result<ResourceList, String> {
    k8s::resources::list_resources(&resource_type, namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn list_pods_by_selector(
    namespace: String,
    selector: String,
) -> Result<ResourceList, String> {
    k8s::resources::list_pods_by_selector(&namespace, &selector)
        .await
        .str_err()
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(kind, name, namespace))]
pub async fn get_resource_yaml(
    kind: String,
    name: String,
    namespace: String,
) -> Result<String, String> {
    k8s::resources::get_resource_yaml(&kind, &name, &namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn apply_yaml(yaml: String) -> Result<String, String> {
    k8s::resources::apply_resource_yaml(&yaml).await.str_err()
}

#[tauri::command]
pub async fn delete_resource(
    kind: String,
    name: String,
    namespace: String,
    uid: Option<String>,
    resource_version: Option<String>,
) -> Result<(), String> {
    k8s::resources::delete_resource(
        &kind,
        &name,
        &namespace,
        uid.as_deref(),
        resource_version.as_deref(),
    )
    .await
    .str_err()
}

#[tauri::command]
pub async fn get_events(
    namespace: Option<String>,
    field_selector: Option<String>,
) -> Result<Vec<EventItem>, String> {
    k8s::resources::get_events(namespace, field_selector)
        .await
        .str_err()
}

#[tauri::command]
pub async fn get_resource_counts(
    resource_types: Vec<String>,
    namespace: Option<String>,
) -> Result<std::collections::HashMap<String, u32>, String> {
    k8s::resources::get_resource_counts(resource_types, namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn get_resource_events(
    resource_type: String,
    name: String,
    namespace: String,
) -> Result<Vec<EventItem>, String> {
    k8s::resources::get_resource_events(&resource_type, &name, &namespace)
        .await
        .str_err()
}

// ===========================================================================
// Workload Operations
// ===========================================================================

#[tauri::command]
pub async fn scale_workload(
    kind: String,
    name: String,
    namespace: String,
    replicas: u32,
) -> Result<(), String> {
    k8s::resources::scale_workload(&kind, &name, &namespace, replicas)
        .await
        .str_err()
}

#[tauri::command]
pub async fn restart_workload(kind: String, name: String, namespace: String) -> Result<(), String> {
    k8s::resources::restart_workload(&kind, &name, &namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn rollback_deployment(
    name: String,
    namespace: String,
    revision: Option<u64>,
) -> Result<String, String> {
    k8s::resources::rollback_deployment(&name, &namespace, revision)
        .await
        .str_err()
}

#[tauri::command]
pub async fn list_deployment_revisions(
    name: String,
    namespace: String,
) -> Result<Vec<RevisionInfo>, String> {
    k8s::resources::list_deployment_revisions(&name, &namespace)
        .await
        .str_err()
}

// ===========================================================================
// Port Forwarding
// ===========================================================================

#[tauri::command]
pub async fn start_port_forward(
    pod_name: String,
    namespace: String,
    container_port: u16,
    local_port: u16,
    session_id: String,
    app_handle: tauri::AppHandle,
) -> Result<PortForwardResult, String> {
    k8s::portforward::start_port_forward(
        pod_name,
        namespace,
        container_port,
        local_port,
        session_id,
        app_handle,
    )
    .await
    .str_err()
}

#[tauri::command]
pub async fn stop_port_forward(session_id: String) -> Result<(), String> {
    k8s::portforward::stop_port_forward(&session_id)
        .await
        .str_err()
}

// ===========================================================================
// Terminal Exec
// ===========================================================================

#[tauri::command]
pub async fn start_terminal_exec(
    name: String,
    namespace: String,
    container: Option<String>,
    command: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    k8s::exec::start_exec(name, namespace, container, command, app_handle)
        .await
        .str_err()
}

#[tauri::command]
pub async fn stop_terminal_exec() -> Result<(), String> {
    k8s::exec::stop_exec().await;
    Ok(())
}

#[tauri::command]
pub async fn send_terminal_input(data: String) -> Result<(), String> {
    k8s::exec::write_stdin(data).await.str_err()
}

#[tauri::command]
pub async fn resize_terminal(width: u16, height: u16) -> Result<(), String> {
    k8s::exec::resize_terminal(width, height).await.str_err()
}

// ===========================================================================
// Logs
// ===========================================================================

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_pod_logs(
    name: String,
    namespace: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    previous: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    k8s::logs::stream_pod_logs(
        name,
        namespace,
        container,
        tail_lines,
        since_seconds,
        timestamps,
        previous,
        app_handle,
    )
    .await
    .str_err()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_multi_pod_logs(
    pods: Vec<String>,
    namespace: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    previous: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    k8s::logs::stream_multi_pod_logs(
        pods,
        namespace,
        container,
        tail_lines,
        since_seconds,
        timestamps,
        previous,
        app_handle,
    )
    .await
    .str_err()
}

#[tauri::command]
pub async fn stop_log_stream() -> Result<(), String> {
    k8s::logs::stop_log_stream();
    Ok(())
}

// ===========================================================================
// Watch
// ===========================================================================

#[tauri::command]
pub async fn start_resource_watch(
    resource_type: String,
    namespace: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    k8s::watch::start_watch(resource_type, namespace, app_handle)
        .await
        .str_err()
}

#[tauri::command]
pub async fn stop_resource_watch() -> Result<(), String> {
    k8s::watch::stop_watch().await;
    Ok(())
}

// ===========================================================================
// Topology
// ===========================================================================

#[tauri::command]
pub async fn get_namespace_topology(namespace: Option<String>) -> Result<TopologyGraph, String> {
    k8s::topology::get_namespace_topology(namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn get_resource_topology(
    uid: String,
    namespace: Option<String>,
) -> Result<TopologyGraph, String> {
    k8s::topology::get_resource_topology(uid, namespace)
        .await
        .str_err()
}

// ===========================================================================
// Diagnostics
// ===========================================================================

#[tauri::command]
pub async fn diagnose_resource(
    kind: String,
    name: String,
    namespace: String,
) -> Result<DiagnosticResult, String> {
    k8s::diagnostics::diagnose_resource(&kind, &name, &namespace)
        .await
        .str_err()
}

// ===========================================================================
// Cost
// ===========================================================================

#[tauri::command]
pub async fn get_cost_overview(namespace: Option<String>) -> Result<CostOverview, String> {
    k8s::cost::get_cost_overview(namespace).await.str_err()
}

#[tauri::command]
pub async fn refresh_pricing() -> Result<(), String> {
    k8s::cost::refresh_pricing().await.str_err()
}

#[tauri::command]
pub async fn get_node_costs() -> Result<Vec<NodeCostInfo>, String> {
    k8s::cost::get_node_costs().await.str_err()
}

#[tauri::command]
pub async fn get_node_metrics() -> Result<Vec<NodeMetricsInfo>, String> {
    k8s::cost::get_node_metrics().await.str_err()
}

// ===========================================================================
// Security
// ===========================================================================

#[tauri::command]
pub async fn get_security_overview(namespace: Option<String>) -> Result<SecurityOverview, String> {
    k8s::security::get_security_overview(namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn scan_image(image: String) -> Result<ImageScanResult, String> {
    k8s::security::scan_single_image(image).await.str_err()
}

// ===========================================================================
// Custom Resource Definitions (CRDs)
// ===========================================================================

#[tauri::command]
pub async fn discover_crds() -> Result<Vec<CrdGroup>, String> {
    k8s::crd::discover_crds().await.str_err()
}

#[tauri::command]
pub async fn list_crd_resources(
    group: String,
    version: String,
    kind: String,
    plural: String,
    scope: String,
    namespace: Option<String>,
) -> Result<CrdResourceList, String> {
    k8s::crd::list_crd_resources(group, version, kind, plural, scope, namespace)
        .await
        .str_err()
}

#[tauri::command]
pub async fn get_crd_counts(
    crds: Vec<CrdInfo>,
    namespace: Option<String>,
) -> Result<std::collections::HashMap<String, u32>, String> {
    k8s::crd::get_crd_counts(crds, namespace).await.str_err()
}

#[tauri::command]
pub async fn get_crd_conditions(
    resource: k8s::resources::Resource,
) -> Result<Vec<StatusCondition>, String> {
    Ok(k8s::crd::extract_conditions(&resource))
}
