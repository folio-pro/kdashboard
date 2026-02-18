use super::StatusType;
use k8s_client::{Resource, ResourceType};
use serde_json::Value;
use std::cmp::Ordering;

pub(crate) fn get_hpa_status(resource: &Resource) -> (StatusType, &'static str) {
    let current = get_json_value(&resource.status, &["currentReplicas"])
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let desired = get_json_value(&resource.status, &["desiredReplicas"])
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let conditions = get_json_value(&resource.status, &["conditions"]).and_then(|v| v.as_array());
    if let Some(conds) = conditions {
        for cond in conds {
            let cond_type = cond.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let status = cond.get("status").and_then(|s| s.as_str()).unwrap_or("");

            if cond_type == "ScalingLimited" && status == "True" {
                return (StatusType::Pending, "Limited");
            }
            if cond_type == "AbleToScale" && status == "False" {
                return (StatusType::Failed, "Unable");
            }
        }
    }

    if current == 0 && desired == 0 {
        (StatusType::Unknown, "Idle")
    } else if current < desired {
        (StatusType::Pending, "Scaling Up")
    } else if current > desired {
        (StatusType::Pending, "Scaling Down")
    } else {
        (StatusType::Ready, "Stable")
    }
}

pub(crate) fn get_vpa_status(resource: &Resource) -> (StatusType, &'static str) {
    let has_recommendation = get_json_value(
        &resource.status,
        &["recommendation", "containerRecommendations"],
    )
    .and_then(|v| v.as_array())
    .map(|a| !a.is_empty())
    .unwrap_or(false);

    let conditions = get_json_value(&resource.status, &["conditions"]).and_then(|v| v.as_array());
    if let Some(conds) = conditions {
        for cond in conds {
            let cond_type = cond.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let status = cond.get("status").and_then(|s| s.as_str()).unwrap_or("");

            if cond_type == "RecommendationProvided" && status == "True" {
                return (StatusType::Ready, "Ready");
            }
            if cond_type == "LowConfidence" && status == "True" {
                return (StatusType::Pending, "Low Conf.");
            }
            if cond_type == "NoPodsMatched" && status == "True" {
                return (StatusType::Pending, "No Pods");
            }
            if cond_type == "ConfigUnsupported" && status == "True" {
                return (StatusType::Failed, "Invalid");
            }
        }
    }

    if has_recommendation {
        (StatusType::Ready, "Active")
    } else {
        (StatusType::Pending, "Pending")
    }
}

pub(crate) fn get_vpa_recommendation(resource: &Resource, resource_name: &str) -> String {
    let containers = get_json_value(
        &resource.status,
        &["recommendation", "containerRecommendations"],
    )
    .and_then(|v| v.as_array());

    if let Some(containers) = containers {
        if let Some(first) = containers.first() {
            let target = first
                .get("target")
                .and_then(|t| t.get(resource_name))
                .and_then(|v| v.as_str());

            let lower = first
                .get("lowerBound")
                .and_then(|t| t.get(resource_name))
                .and_then(|v| v.as_str());

            let upper = first
                .get("upperBound")
                .and_then(|t| t.get(resource_name))
                .and_then(|v| v.as_str());

            if let Some(t) = target {
                let bounds = match (lower, upper) {
                    (Some(l), Some(u)) => format!(
                        " ({}-{})",
                        format_resource_value(l),
                        format_resource_value(u)
                    ),
                    _ => String::new(),
                };
                return format!("{}{}", format_resource_value(t), bounds);
            }
        }
    }

    "-".to_string()
}

fn format_resource_value(value: &str) -> String {
    if value.ends_with("Ki") {
        let num: f64 = value.trim_end_matches("Ki").parse().unwrap_or(0.0);
        if num >= 1024.0 * 1024.0 {
            return format!("{:.1}Gi", num / 1024.0 / 1024.0);
        } else if num >= 1024.0 {
            return format!("{:.0}Mi", num / 1024.0);
        }
        return format!("{:.0}Ki", num);
    }

    if value.ends_with("Mi") {
        let num: f64 = value.trim_end_matches("Mi").parse().unwrap_or(0.0);
        if num >= 1024.0 {
            return format!("{:.1}Gi", num / 1024.0);
        }
        return format!("{:.0}Mi", num);
    }

    if value.ends_with("Gi") {
        return value.to_string();
    }

    if value.ends_with('m') {
        let millis: f64 = value.trim_end_matches('m').parse().unwrap_or(0.0);
        if millis >= 1000.0 {
            return format!("{:.1}", millis / 1000.0);
        }
        return format!("{}m", millis as u64);
    }

    if let Ok(cores) = value.parse::<f64>() {
        if cores < 1.0 {
            return format!("{}m", (cores * 1000.0) as u64);
        }
        return format!("{:.1}", cores);
    }

    value.to_string()
}

pub(crate) fn get_json_value<'a>(value: &'a Option<Value>, path: &[&str]) -> Option<&'a Value> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

pub(crate) fn get_pod_ready_count(resource: &Resource) -> (u64, u64) {
    let container_statuses =
        get_json_value(&resource.status, &["containerStatuses"]).and_then(|v| v.as_array());
    let containers = get_json_value(&resource.spec, &["containers"]).and_then(|v| v.as_array());

    let total = containers.map(|c| c.len() as u64).unwrap_or(1);
    let ready = container_statuses
        .map(|statuses| {
            statuses
                .iter()
                .filter(|s| s.get("ready").and_then(|r| r.as_bool()).unwrap_or(false))
                .count() as u64
        })
        .unwrap_or(0);

    (ready, total)
}

pub(crate) fn get_pod_restarts(resource: &Resource) -> u64 {
    let container_statuses =
        get_json_value(&resource.status, &["containerStatuses"]).and_then(|v| v.as_array());

    container_statuses
        .map(|statuses| {
            statuses
                .iter()
                .map(|s| s.get("restartCount").and_then(|r| r.as_u64()).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0)
}

pub(crate) fn get_deployment_ready_count(resource: &Resource) -> (u64, u64) {
    let ready = get_json_value(&resource.status, &["readyReplicas"])
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let total = get_json_value(&resource.spec, &["replicas"])
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    (ready, total)
}

pub(crate) fn get_service_ports(resource: &Resource) -> String {
    let ports = get_json_value(&resource.spec, &["ports"]).and_then(|v| v.as_array());
    ports
        .map(|ports| {
            ports
                .iter()
                .filter_map(|p| {
                    let port = p.get("port").and_then(|v| v.as_u64())?;
                    let protocol = p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP");
                    Some(format!("{}/{}", port, protocol))
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "-".to_string())
}

pub(crate) fn get_node_roles(resource: &Resource) -> String {
    let labels = &resource.metadata.labels;
    let mut roles = Vec::new();

    if let Some(labels) = labels {
        if labels.contains_key("node-role.kubernetes.io/control-plane") {
            roles.push("control-plane");
        }
        if labels.contains_key("node-role.kubernetes.io/master") {
            roles.push("master");
        }
        if labels.contains_key("node-role.kubernetes.io/worker") {
            roles.push("worker");
        }
    }

    if roles.is_empty() {
        roles.push("worker");
    }

    roles.join(", ")
}

pub(crate) fn get_resource_status(resource: &Resource) -> StatusType {
    match resource.kind.as_str() {
        "Pod" => {
            let phase = get_json_value(&resource.status, &["phase"])
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();

            match phase.as_str() {
                "running" => StatusType::Ready,
                "pending" => StatusType::Pending,
                "failed" | "crashloopbackoff" => StatusType::Failed,
                "succeeded" => StatusType::Ready,
                _ => StatusType::Unknown,
            }
        }
        "Deployment" => {
            let available = get_json_value(&resource.status, &["availableReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let desired = get_json_value(&resource.spec, &["replicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            if available == desired && desired > 0 {
                StatusType::Ready
            } else if available < desired {
                StatusType::Pending
            } else {
                StatusType::Unknown
            }
        }
        "Service" | "ConfigMap" | "Secret" => StatusType::Ready,
        _ => StatusType::Unknown,
    }
}

pub(crate) fn get_node_status(resource: &Resource) -> StatusType {
    let conditions = get_json_value(&resource.status, &["conditions"]).and_then(|v| v.as_array());

    if let Some(conditions) = conditions {
        for cond in conditions {
            if cond.get("type").and_then(|t| t.as_str()) == Some("Ready") {
                let status = cond.get("status").and_then(|s| s.as_str()).unwrap_or("");
                return match status {
                    "True" => StatusType::Ready,
                    "False" => StatusType::Failed,
                    _ => StatusType::Unknown,
                };
            }
        }
    }

    StatusType::Unknown
}

pub(crate) fn get_resource_issue_status(resource: &Resource) -> Option<StatusType> {
    let status = match resource.kind.as_str() {
        "Node" => get_node_status(resource),
        "Namespace" => {
            let phase = get_json_value(&resource.status, &["phase"])
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");
            if phase.eq_ignore_ascii_case("terminating") {
                StatusType::Pending
            } else {
                StatusType::Unknown
            }
        }
        _ => get_resource_status(resource),
    };

    match status {
        StatusType::Pending | StatusType::Failed => Some(status),
        _ => None,
    }
}

pub(crate) fn format_age(timestamp: &Option<String>) -> String {
    let Some(ts) = timestamp else {
        return "-".to_string();
    };

    let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) else {
        return "-".to_string();
    };

    let now = chrono::Utc::now();
    let duration = now.signed_duration_since(date.with_timezone(&chrono::Utc));
    let days = duration.num_days();
    let hours = duration.num_hours() % 24;
    let minutes = duration.num_minutes() % 60;

    if days > 0 {
        format!("{}d", days)
    } else if hours > 0 {
        format!("{}h", hours)
    } else if minutes > 0 {
        format!("{}m", minutes)
    } else {
        format!("{}s", duration.num_seconds().max(0))
    }
}

fn get_age_seconds(timestamp: &Option<String>) -> i64 {
    let Some(ts) = timestamp else {
        return i64::MAX;
    };

    let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) else {
        return i64::MAX;
    };

    let now = chrono::Utc::now();
    now.signed_duration_since(date.with_timezone(&chrono::Utc))
        .num_seconds()
}

pub(crate) fn compare_resources_by_column(
    a: &Resource,
    b: &Resource,
    column: &str,
    resource_type: ResourceType,
) -> Ordering {
    match column {
        "Name" => a.metadata.name.cmp(&b.metadata.name),
        "Namespace" => {
            let ns_a = a.metadata.namespace.as_deref().unwrap_or("");
            let ns_b = b.metadata.namespace.as_deref().unwrap_or("");
            ns_a.cmp(ns_b)
        }
        "Age" => {
            let age_a = get_age_seconds(&a.metadata.creation_timestamp);
            let age_b = get_age_seconds(&b.metadata.creation_timestamp);
            age_a.cmp(&age_b)
        }
        "Status" => {
            let status_a = get_resource_status(a);
            let status_b = get_resource_status(b);
            status_order(status_a).cmp(&status_order(status_b))
        }
        "Ready" => match resource_type {
            ResourceType::Pods => {
                let (ready_a, total_a) = get_pod_ready_count(a);
                let (ready_b, total_b) = get_pod_ready_count(b);
                let ratio_a = if total_a > 0 {
                    ready_a as f64 / total_a as f64
                } else {
                    0.0
                };
                let ratio_b = if total_b > 0 {
                    ready_b as f64 / total_b as f64
                } else {
                    0.0
                };
                ratio_a.partial_cmp(&ratio_b).unwrap_or(Ordering::Equal)
            }
            ResourceType::Deployments => {
                let (ready_a, total_a) = get_deployment_ready_count(a);
                let (ready_b, total_b) = get_deployment_ready_count(b);
                let ratio_a = if total_a > 0 {
                    ready_a as f64 / total_a as f64
                } else {
                    0.0
                };
                let ratio_b = if total_b > 0 {
                    ready_b as f64 / total_b as f64
                } else {
                    0.0
                };
                ratio_a.partial_cmp(&ratio_b).unwrap_or(Ordering::Equal)
            }
            _ => Ordering::Equal,
        },
        "Restarts" => {
            let restarts_a = get_pod_restarts(a);
            let restarts_b = get_pod_restarts(b);
            restarts_a.cmp(&restarts_b)
        }
        "Type" => {
            let type_a = get_json_value(&a.spec, &["type"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let type_b = get_json_value(&b.spec, &["type"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            type_a.cmp(type_b)
        }
        "Cluster-IP" => {
            let ip_a = get_json_value(&a.spec, &["clusterIP"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ip_b = get_json_value(&b.spec, &["clusterIP"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ip_a.cmp(ip_b)
        }
        "Ports" => {
            let ports_a = get_service_ports(a);
            let ports_b = get_service_ports(b);
            ports_a.cmp(&ports_b)
        }
        "Up-to-date" => {
            let updated_a = get_json_value(&a.status, &["updatedReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let updated_b = get_json_value(&b.status, &["updatedReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            updated_a.cmp(&updated_b)
        }
        "Available" => {
            let available_a = get_json_value(&a.status, &["availableReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let available_b = get_json_value(&b.status, &["availableReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            available_a.cmp(&available_b)
        }
        "Roles" => {
            let roles_a = get_node_roles(a);
            let roles_b = get_node_roles(b);
            roles_a.cmp(&roles_b)
        }
        "Version" => {
            let version_a = get_json_value(&a.status, &["nodeInfo", "kubeletVersion"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let version_b = get_json_value(&b.status, &["nodeInfo", "kubeletVersion"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            version_a.cmp(version_b)
        }
        "Node" => {
            let node_a = get_json_value(&a.spec, &["nodeName"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let node_b = get_json_value(&b.spec, &["nodeName"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            node_a.cmp(node_b)
        }
        _ => Ordering::Equal,
    }
}

fn status_order(status: StatusType) -> u8 {
    match status {
        StatusType::Failed => 0,
        StatusType::Pending => 1,
        StatusType::Unknown => 2,
        StatusType::Ready => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn make_resource(kind: &str) -> Resource {
        Resource {
            api_version: "v1".to_string(),
            kind: kind.to_string(),
            metadata: k8s_client::ResourceMetadata {
                name: "test".to_string(),
                namespace: Some("default".to_string()),
                uid: "uid-123".to_string(),
                resource_version: "1".to_string(),
                labels: None,
                annotations: None,
                creation_timestamp: None,
                owner_references: None,
            },
            spec: None,
            status: None,
            data: None,
            type_: None,
        }
    }

    // ── get_json_value ──────────────────────────────────────────────

    #[test]
    fn get_json_value_returns_nested_value() {
        let val = Some(json!({"a": {"b": {"c": 42}}}));
        let result = get_json_value(&val, &["a", "b", "c"]);
        assert_eq!(result, Some(&json!(42)));
    }

    #[test]
    fn get_json_value_returns_none_for_missing_path() {
        let val = Some(json!({"a": 1}));
        assert!(get_json_value(&val, &["x", "y"]).is_none());
    }

    #[test]
    fn get_json_value_returns_none_for_none_input() {
        assert!(get_json_value(&None, &["a"]).is_none());
    }

    #[test]
    fn get_json_value_returns_root_for_empty_path() {
        let val = Some(json!({"a": 1}));
        assert_eq!(get_json_value(&val, &[]), Some(&json!({"a": 1})));
    }

    // ── format_age ──────────────────────────────────────────────────

    #[test]
    fn format_age_returns_dash_for_none() {
        assert_eq!(format_age(&None), "-");
    }

    #[test]
    fn format_age_returns_dash_for_invalid_timestamp() {
        assert_eq!(format_age(&Some("not-a-date".to_string())), "-");
    }

    #[test]
    fn format_age_shows_days() {
        let ts = (chrono::Utc::now() - chrono::Duration::days(3)).to_rfc3339();
        assert_eq!(format_age(&Some(ts)), "3d");
    }

    #[test]
    fn format_age_shows_hours() {
        let ts = (chrono::Utc::now() - chrono::Duration::hours(5)).to_rfc3339();
        assert_eq!(format_age(&Some(ts)), "5h");
    }

    #[test]
    fn format_age_shows_minutes() {
        let ts = (chrono::Utc::now() - chrono::Duration::minutes(15)).to_rfc3339();
        assert_eq!(format_age(&Some(ts)), "15m");
    }

    #[test]
    fn format_age_shows_seconds_for_recent() {
        let ts = (chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339();
        assert_eq!(format_age(&Some(ts)), "30s");
    }

    #[test]
    fn format_age_zero_seconds_for_now() {
        let ts = chrono::Utc::now().to_rfc3339();
        assert_eq!(format_age(&Some(ts)), "0s");
    }

    // ── format_resource_value ───────────────────────────────────────

    #[test]
    fn format_resource_value_ki_small() {
        assert_eq!(format_resource_value("512Ki"), "512Ki");
    }

    #[test]
    fn format_resource_value_ki_to_mi() {
        assert_eq!(format_resource_value("2048Ki"), "2Mi");
    }

    #[test]
    fn format_resource_value_ki_to_gi() {
        let ki = (1024 * 1024 * 2) as f64;
        assert_eq!(format_resource_value(&format!("{}Ki", ki)), "2.0Gi");
    }

    #[test]
    fn format_resource_value_mi_small() {
        assert_eq!(format_resource_value("256Mi"), "256Mi");
    }

    #[test]
    fn format_resource_value_mi_to_gi() {
        assert_eq!(format_resource_value("2048Mi"), "2.0Gi");
    }

    #[test]
    fn format_resource_value_gi_passthrough() {
        assert_eq!(format_resource_value("4Gi"), "4Gi");
    }

    #[test]
    fn format_resource_value_millicores_small() {
        assert_eq!(format_resource_value("250m"), "250m");
    }

    #[test]
    fn format_resource_value_millicores_to_cores() {
        assert_eq!(format_resource_value("2000m"), "2.0");
    }

    #[test]
    fn format_resource_value_cores_fractional() {
        assert_eq!(format_resource_value("0.5"), "500m");
    }

    #[test]
    fn format_resource_value_cores_whole() {
        assert_eq!(format_resource_value("2"), "2.0");
    }

    #[test]
    fn format_resource_value_unknown_passthrough() {
        assert_eq!(format_resource_value("unknown"), "unknown");
    }

    // ── get_pod_ready_count ─────────────────────────────────────────

    #[test]
    fn get_pod_ready_count_with_all_ready() {
        let mut r = make_resource("Pod");
        r.spec = Some(json!({"containers": [{"name": "a"}, {"name": "b"}]}));
        r.status = Some(json!({
            "containerStatuses": [
                {"name": "a", "ready": true, "restartCount": 0},
                {"name": "b", "ready": true, "restartCount": 0}
            ]
        }));
        assert_eq!(get_pod_ready_count(&r), (2, 2));
    }

    #[test]
    fn get_pod_ready_count_with_partial_ready() {
        let mut r = make_resource("Pod");
        r.spec = Some(json!({"containers": [{"name": "a"}, {"name": "b"}]}));
        r.status = Some(json!({
            "containerStatuses": [
                {"name": "a", "ready": true, "restartCount": 0},
                {"name": "b", "ready": false, "restartCount": 0}
            ]
        }));
        assert_eq!(get_pod_ready_count(&r), (1, 2));
    }

    #[test]
    fn get_pod_ready_count_with_no_status() {
        let mut r = make_resource("Pod");
        r.spec = Some(json!({"containers": [{"name": "a"}]}));
        assert_eq!(get_pod_ready_count(&r), (0, 1));
    }

    // ── get_pod_restarts ────────────────────────────────────────────

    #[test]
    fn get_pod_restarts_sums_all_containers() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({
            "containerStatuses": [
                {"restartCount": 3},
                {"restartCount": 5}
            ]
        }));
        assert_eq!(get_pod_restarts(&r), 8);
    }

    #[test]
    fn get_pod_restarts_zero_when_no_status() {
        let r = make_resource("Pod");
        assert_eq!(get_pod_restarts(&r), 0);
    }

    // ── get_deployment_ready_count ──────────────────────────────────

    #[test]
    fn get_deployment_ready_count_all_ready() {
        let mut r = make_resource("Deployment");
        r.spec = Some(json!({"replicas": 3}));
        r.status = Some(json!({"readyReplicas": 3}));
        assert_eq!(get_deployment_ready_count(&r), (3, 3));
    }

    #[test]
    fn get_deployment_ready_count_partial() {
        let mut r = make_resource("Deployment");
        r.spec = Some(json!({"replicas": 3}));
        r.status = Some(json!({"readyReplicas": 1}));
        assert_eq!(get_deployment_ready_count(&r), (1, 3));
    }

    #[test]
    fn get_deployment_ready_count_no_status() {
        let mut r = make_resource("Deployment");
        r.spec = Some(json!({"replicas": 2}));
        assert_eq!(get_deployment_ready_count(&r), (0, 2));
    }

    // ── get_service_ports ───────────────────────────────────────────

    #[test]
    fn get_service_ports_formats_ports() {
        let mut r = make_resource("Service");
        r.spec = Some(json!({
            "ports": [
                {"port": 80, "protocol": "TCP"},
                {"port": 443, "protocol": "TCP"}
            ]
        }));
        assert_eq!(get_service_ports(&r), "80/TCP, 443/TCP");
    }

    #[test]
    fn get_service_ports_defaults_protocol_to_tcp() {
        let mut r = make_resource("Service");
        r.spec = Some(json!({
            "ports": [{"port": 8080}]
        }));
        assert_eq!(get_service_ports(&r), "8080/TCP");
    }

    #[test]
    fn get_service_ports_returns_dash_when_no_ports() {
        let r = make_resource("Service");
        assert_eq!(get_service_ports(&r), "-");
    }

    // ── get_node_roles ──────────────────────────────────────────────

    #[test]
    fn get_node_roles_control_plane() {
        let mut r = make_resource("Node");
        let mut labels = BTreeMap::new();
        labels.insert("node-role.kubernetes.io/control-plane".to_string(), "".to_string());
        r.metadata.labels = Some(labels);
        assert_eq!(get_node_roles(&r), "control-plane");
    }

    #[test]
    fn get_node_roles_multiple() {
        let mut r = make_resource("Node");
        let mut labels = BTreeMap::new();
        labels.insert("node-role.kubernetes.io/control-plane".to_string(), "".to_string());
        labels.insert("node-role.kubernetes.io/master".to_string(), "".to_string());
        r.metadata.labels = Some(labels);
        assert_eq!(get_node_roles(&r), "control-plane, master");
    }

    #[test]
    fn get_node_roles_defaults_to_worker() {
        let r = make_resource("Node");
        assert_eq!(get_node_roles(&r), "worker");
    }

    // ── get_resource_status ─────────────────────────────────────────

    #[test]
    fn get_resource_status_pod_running() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Running"}));
        assert_eq!(get_resource_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_resource_status_pod_pending() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Pending"}));
        assert_eq!(get_resource_status(&r), StatusType::Pending);
    }

    #[test]
    fn get_resource_status_pod_failed() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Failed"}));
        assert_eq!(get_resource_status(&r), StatusType::Failed);
    }

    #[test]
    fn get_resource_status_pod_succeeded() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Succeeded"}));
        assert_eq!(get_resource_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_resource_status_pod_unknown_phase() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "SomethingElse"}));
        assert_eq!(get_resource_status(&r), StatusType::Unknown);
    }

    #[test]
    fn get_resource_status_deployment_ready() {
        let mut r = make_resource("Deployment");
        r.spec = Some(json!({"replicas": 3}));
        r.status = Some(json!({"availableReplicas": 3}));
        assert_eq!(get_resource_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_resource_status_deployment_pending() {
        let mut r = make_resource("Deployment");
        r.spec = Some(json!({"replicas": 3}));
        r.status = Some(json!({"availableReplicas": 1}));
        assert_eq!(get_resource_status(&r), StatusType::Pending);
    }

    #[test]
    fn get_resource_status_deployment_zero_zero() {
        let mut r = make_resource("Deployment");
        r.spec = Some(json!({"replicas": 0}));
        r.status = Some(json!({"availableReplicas": 0}));
        assert_eq!(get_resource_status(&r), StatusType::Unknown);
    }

    #[test]
    fn get_resource_status_service_always_ready() {
        let r = make_resource("Service");
        assert_eq!(get_resource_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_resource_status_configmap_always_ready() {
        let r = make_resource("ConfigMap");
        assert_eq!(get_resource_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_resource_status_secret_always_ready() {
        let r = make_resource("Secret");
        assert_eq!(get_resource_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_resource_status_unknown_kind() {
        let r = make_resource("CustomResource");
        assert_eq!(get_resource_status(&r), StatusType::Unknown);
    }

    // ── get_node_status ─────────────────────────────────────────────

    #[test]
    fn get_node_status_ready() {
        let mut r = make_resource("Node");
        r.status = Some(json!({
            "conditions": [{"type": "Ready", "status": "True"}]
        }));
        assert_eq!(get_node_status(&r), StatusType::Ready);
    }

    #[test]
    fn get_node_status_not_ready() {
        let mut r = make_resource("Node");
        r.status = Some(json!({
            "conditions": [{"type": "Ready", "status": "False"}]
        }));
        assert_eq!(get_node_status(&r), StatusType::Failed);
    }

    #[test]
    fn get_node_status_unknown() {
        let mut r = make_resource("Node");
        r.status = Some(json!({
            "conditions": [{"type": "Ready", "status": "Unknown"}]
        }));
        assert_eq!(get_node_status(&r), StatusType::Unknown);
    }

    #[test]
    fn get_node_status_no_conditions() {
        let r = make_resource("Node");
        assert_eq!(get_node_status(&r), StatusType::Unknown);
    }

    // ── get_resource_issue_status ───────────────────────────────────

    #[test]
    fn get_resource_issue_status_returns_none_for_ready() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Running"}));
        assert!(get_resource_issue_status(&r).is_none());
    }

    #[test]
    fn get_resource_issue_status_returns_some_for_pending() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Pending"}));
        assert_eq!(get_resource_issue_status(&r), Some(StatusType::Pending));
    }

    #[test]
    fn get_resource_issue_status_returns_some_for_failed() {
        let mut r = make_resource("Pod");
        r.status = Some(json!({"phase": "Failed"}));
        assert_eq!(get_resource_issue_status(&r), Some(StatusType::Failed));
    }

    #[test]
    fn get_resource_issue_status_namespace_terminating() {
        let mut r = make_resource("Namespace");
        r.status = Some(json!({"phase": "Terminating"}));
        assert_eq!(get_resource_issue_status(&r), Some(StatusType::Pending));
    }

    #[test]
    fn get_resource_issue_status_namespace_active_is_none() {
        let mut r = make_resource("Namespace");
        r.status = Some(json!({"phase": "Active"}));
        assert!(get_resource_issue_status(&r).is_none());
    }

    // ── get_hpa_status ──────────────────────────────────────────────

    #[test]
    fn get_hpa_status_stable() {
        let mut r = make_resource("HorizontalPodAutoscaler");
        r.status = Some(json!({"currentReplicas": 3, "desiredReplicas": 3}));
        let (status, label) = get_hpa_status(&r);
        assert_eq!(status, StatusType::Ready);
        assert_eq!(label, "Stable");
    }

    #[test]
    fn get_hpa_status_scaling_up() {
        let mut r = make_resource("HorizontalPodAutoscaler");
        r.status = Some(json!({"currentReplicas": 1, "desiredReplicas": 3}));
        let (status, label) = get_hpa_status(&r);
        assert_eq!(status, StatusType::Pending);
        assert_eq!(label, "Scaling Up");
    }

    #[test]
    fn get_hpa_status_scaling_down() {
        let mut r = make_resource("HorizontalPodAutoscaler");
        r.status = Some(json!({"currentReplicas": 5, "desiredReplicas": 2}));
        let (status, label) = get_hpa_status(&r);
        assert_eq!(status, StatusType::Pending);
        assert_eq!(label, "Scaling Down");
    }

    #[test]
    fn get_hpa_status_idle() {
        let mut r = make_resource("HorizontalPodAutoscaler");
        r.status = Some(json!({"currentReplicas": 0, "desiredReplicas": 0}));
        let (status, label) = get_hpa_status(&r);
        assert_eq!(status, StatusType::Unknown);
        assert_eq!(label, "Idle");
    }

    #[test]
    fn get_hpa_status_scaling_limited() {
        let mut r = make_resource("HorizontalPodAutoscaler");
        r.status = Some(json!({
            "currentReplicas": 3, "desiredReplicas": 3,
            "conditions": [{"type": "ScalingLimited", "status": "True"}]
        }));
        let (status, label) = get_hpa_status(&r);
        assert_eq!(status, StatusType::Pending);
        assert_eq!(label, "Limited");
    }

    #[test]
    fn get_hpa_status_unable_to_scale() {
        let mut r = make_resource("HorizontalPodAutoscaler");
        r.status = Some(json!({
            "currentReplicas": 1, "desiredReplicas": 3,
            "conditions": [{"type": "AbleToScale", "status": "False"}]
        }));
        let (status, label) = get_hpa_status(&r);
        assert_eq!(status, StatusType::Failed);
        assert_eq!(label, "Unable");
    }

    // ── get_vpa_status ──────────────────────────────────────────────

    #[test]
    fn get_vpa_status_ready_with_condition() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "conditions": [{"type": "RecommendationProvided", "status": "True"}]
        }));
        let (status, label) = get_vpa_status(&r);
        assert_eq!(status, StatusType::Ready);
        assert_eq!(label, "Ready");
    }

    #[test]
    fn get_vpa_status_low_confidence() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "conditions": [{"type": "LowConfidence", "status": "True"}]
        }));
        let (status, label) = get_vpa_status(&r);
        assert_eq!(status, StatusType::Pending);
        assert_eq!(label, "Low Conf.");
    }

    #[test]
    fn get_vpa_status_no_pods() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "conditions": [{"type": "NoPodsMatched", "status": "True"}]
        }));
        let (status, label) = get_vpa_status(&r);
        assert_eq!(status, StatusType::Pending);
        assert_eq!(label, "No Pods");
    }

    #[test]
    fn get_vpa_status_invalid() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "conditions": [{"type": "ConfigUnsupported", "status": "True"}]
        }));
        let (status, label) = get_vpa_status(&r);
        assert_eq!(status, StatusType::Failed);
        assert_eq!(label, "Invalid");
    }

    #[test]
    fn get_vpa_status_active_with_recommendation() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "recommendation": {"containerRecommendations": [{"target": {"cpu": "100m"}}]}
        }));
        let (status, label) = get_vpa_status(&r);
        assert_eq!(status, StatusType::Ready);
        assert_eq!(label, "Active");
    }

    #[test]
    fn get_vpa_status_pending_no_recommendation() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({}));
        let (status, label) = get_vpa_status(&r);
        assert_eq!(status, StatusType::Pending);
        assert_eq!(label, "Pending");
    }

    // ── get_vpa_recommendation ──────────────────────────────────────

    #[test]
    fn get_vpa_recommendation_formats_with_bounds() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "recommendation": {
                "containerRecommendations": [{
                    "target": {"memory": "262144Ki"},
                    "lowerBound": {"memory": "131072Ki"},
                    "upperBound": {"memory": "524288Ki"}
                }]
            }
        }));
        assert_eq!(get_vpa_recommendation(&r, "memory"), "256Mi (128Mi-512Mi)");
    }

    #[test]
    fn get_vpa_recommendation_target_only() {
        let mut r = make_resource("VerticalPodAutoscaler");
        r.status = Some(json!({
            "recommendation": {
                "containerRecommendations": [{
                    "target": {"cpu": "250m"}
                }]
            }
        }));
        assert_eq!(get_vpa_recommendation(&r, "cpu"), "250m");
    }

    #[test]
    fn get_vpa_recommendation_returns_dash_when_missing() {
        let r = make_resource("VerticalPodAutoscaler");
        assert_eq!(get_vpa_recommendation(&r, "memory"), "-");
    }

    // ── status_order ────────────────────────────────────────────────

    #[test]
    fn status_order_failed_is_lowest() {
        assert!(status_order(StatusType::Failed) < status_order(StatusType::Pending));
        assert!(status_order(StatusType::Pending) < status_order(StatusType::Unknown));
        assert!(status_order(StatusType::Unknown) < status_order(StatusType::Ready));
    }

    // ── get_age_seconds ─────────────────────────────────────────────

    #[test]
    fn get_age_seconds_returns_max_for_none() {
        assert_eq!(get_age_seconds(&None), i64::MAX);
    }

    #[test]
    fn get_age_seconds_returns_max_for_invalid() {
        assert_eq!(get_age_seconds(&Some("bad".to_string())), i64::MAX);
    }

    #[test]
    fn get_age_seconds_returns_positive_for_past() {
        let ts = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339();
        let secs = get_age_seconds(&Some(ts));
        assert!(secs >= 59 && secs <= 61);
    }

    // ── compare_resources_by_column ─────────────────────────────────

    #[test]
    fn compare_by_name() {
        let mut a = make_resource("Pod");
        a.metadata.name = "alpha".to_string();
        let mut b = make_resource("Pod");
        b.metadata.name = "beta".to_string();
        assert_eq!(
            compare_resources_by_column(&a, &b, "Name", ResourceType::Pods),
            Ordering::Less
        );
    }

    #[test]
    fn compare_by_namespace() {
        let mut a = make_resource("Pod");
        a.metadata.namespace = Some("aaa".to_string());
        let mut b = make_resource("Pod");
        b.metadata.namespace = Some("zzz".to_string());
        assert_eq!(
            compare_resources_by_column(&a, &b, "Namespace", ResourceType::Pods),
            Ordering::Less
        );
    }

    #[test]
    fn compare_by_status() {
        let mut a = make_resource("Pod");
        a.status = Some(json!({"phase": "Failed"}));
        let mut b = make_resource("Pod");
        b.status = Some(json!({"phase": "Running"}));
        assert_eq!(
            compare_resources_by_column(&a, &b, "Status", ResourceType::Pods),
            Ordering::Less
        );
    }

    #[test]
    fn compare_by_restarts() {
        let mut a = make_resource("Pod");
        a.status = Some(json!({"containerStatuses": [{"restartCount": 10}]}));
        let mut b = make_resource("Pod");
        b.status = Some(json!({"containerStatuses": [{"restartCount": 2}]}));
        assert_eq!(
            compare_resources_by_column(&a, &b, "Restarts", ResourceType::Pods),
            Ordering::Greater
        );
    }

    #[test]
    fn compare_unknown_column_is_equal() {
        let a = make_resource("Pod");
        let b = make_resource("Pod");
        assert_eq!(
            compare_resources_by_column(&a, &b, "NonExistent", ResourceType::Pods),
            Ordering::Equal
        );
    }

    #[test]
    fn compare_by_age() {
        let mut a = make_resource("Pod");
        a.metadata.creation_timestamp =
            Some((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
        let mut b = make_resource("Pod");
        b.metadata.creation_timestamp =
            Some((chrono::Utc::now() - chrono::Duration::hours(5)).to_rfc3339());
        // a is newer (2h old, fewer seconds) vs b (5h old, more seconds)
        assert_eq!(
            compare_resources_by_column(&a, &b, "Age", ResourceType::Pods),
            Ordering::Less
        );
    }

    #[test]
    fn compare_by_ready_pods() {
        let mut a = make_resource("Pod");
        a.spec = Some(json!({"containers": [{"name": "a"}]}));
        a.status = Some(json!({"containerStatuses": [{"ready": true, "restartCount": 0}]}));

        let mut b = make_resource("Pod");
        b.spec = Some(json!({"containers": [{"name": "a"}]}));
        b.status = Some(json!({"containerStatuses": [{"ready": false, "restartCount": 0}]}));

        assert_eq!(
            compare_resources_by_column(&a, &b, "Ready", ResourceType::Pods),
            Ordering::Greater
        );
    }

    #[test]
    fn compare_by_type() {
        let mut a = make_resource("Service");
        a.spec = Some(json!({"type": "ClusterIP"}));
        let mut b = make_resource("Service");
        b.spec = Some(json!({"type": "NodePort"}));
        assert_eq!(
            compare_resources_by_column(&a, &b, "Type", ResourceType::Services),
            Ordering::Less
        );
    }
}
