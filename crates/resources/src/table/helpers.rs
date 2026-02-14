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
