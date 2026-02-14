use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    #[default]
    Pods,
    Deployments,
    Services,
    ConfigMaps,
    Secrets,
    Ingresses,
    StatefulSets,
    DaemonSets,
    Jobs,
    CronJobs,
    ReplicaSets,
    Nodes,
    Namespaces,
    HorizontalPodAutoscalers,
    VerticalPodAutoscalers,
}

impl ResourceType {
    pub fn display_name(&self) -> &'static str {
        match self {
            ResourceType::Pods => "Pods",
            ResourceType::Deployments => "Deployments",
            ResourceType::Services => "Services",
            ResourceType::ConfigMaps => "ConfigMaps",
            ResourceType::Secrets => "Secrets",
            ResourceType::Ingresses => "Ingresses",
            ResourceType::StatefulSets => "StatefulSets",
            ResourceType::DaemonSets => "DaemonSets",
            ResourceType::Jobs => "Jobs",
            ResourceType::CronJobs => "CronJobs",
            ResourceType::ReplicaSets => "ReplicaSets",
            ResourceType::Nodes => "Nodes",
            ResourceType::Namespaces => "Namespaces",
            ResourceType::HorizontalPodAutoscalers => "HPA",
            ResourceType::VerticalPodAutoscalers => "VPA",
        }
    }

    pub fn api_name(&self) -> &'static str {
        match self {
            ResourceType::Pods => "pods",
            ResourceType::Deployments => "deployments",
            ResourceType::Services => "services",
            ResourceType::ConfigMaps => "configmaps",
            ResourceType::Secrets => "secrets",
            ResourceType::Ingresses => "ingresses",
            ResourceType::StatefulSets => "statefulsets",
            ResourceType::DaemonSets => "daemonsets",
            ResourceType::Jobs => "jobs",
            ResourceType::CronJobs => "cronjobs",
            ResourceType::ReplicaSets => "replicasets",
            ResourceType::Nodes => "nodes",
            ResourceType::Namespaces => "namespaces",
            ResourceType::HorizontalPodAutoscalers => "horizontalpodautoscalers",
            ResourceType::VerticalPodAutoscalers => "verticalpodautoscalers",
        }
    }

    pub fn is_namespaced(&self) -> bool {
        !matches!(self, ResourceType::Nodes | ResourceType::Namespaces)
    }

    pub fn api_kind(&self) -> &'static str {
        match self {
            ResourceType::Pods => "Pod",
            ResourceType::Deployments => "Deployment",
            ResourceType::Services => "Service",
            ResourceType::ConfigMaps => "ConfigMap",
            ResourceType::Secrets => "Secret",
            ResourceType::Ingresses => "Ingress",
            ResourceType::StatefulSets => "StatefulSet",
            ResourceType::DaemonSets => "DaemonSet",
            ResourceType::Jobs => "Job",
            ResourceType::CronJobs => "CronJob",
            ResourceType::ReplicaSets => "ReplicaSet",
            ResourceType::Nodes => "Node",
            ResourceType::Namespaces => "Namespace",
            ResourceType::HorizontalPodAutoscalers => "HorizontalPodAutoscaler",
            ResourceType::VerticalPodAutoscalers => "VerticalPodAutoscaler",
        }
    }

    pub fn all() -> &'static [ResourceType] {
        &[
            ResourceType::Pods,
            ResourceType::Deployments,
            ResourceType::Services,
            ResourceType::ConfigMaps,
            ResourceType::Secrets,
            ResourceType::Ingresses,
            ResourceType::StatefulSets,
            ResourceType::DaemonSets,
            ResourceType::Jobs,
            ResourceType::CronJobs,
            ResourceType::ReplicaSets,
            ResourceType::Nodes,
            ResourceType::Namespaces,
            ResourceType::HorizontalPodAutoscalers,
            ResourceType::VerticalPodAutoscalers,
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetadata {
    pub name: String,
    pub namespace: Option<String>,
    pub uid: String,
    pub resource_version: String,
    pub labels: Option<BTreeMap<String, String>>,
    pub annotations: Option<BTreeMap<String, String>>,
    pub creation_timestamp: Option<String>,
    #[serde(default)]
    pub owner_references: Option<Vec<OwnerReference>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerReference {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub api_version: String,
    pub kind: String,
    pub metadata: ResourceMetadata,
    pub spec: Option<Value>,
    pub status: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceList {
    pub resource_type: String,
    pub namespace: Option<String>,
    pub items: Vec<Resource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Error,
}

impl Default for ConnectionStatus {
    fn default() -> Self {
        ConnectionStatus::Connecting
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SortDirection {
    Ascending,
    Descending,
}

impl Default for SortDirection {
    fn default() -> Self {
        SortDirection::Ascending
    }
}

impl SortDirection {
    pub fn toggle(&self) -> Self {
        match self {
            SortDirection::Ascending => SortDirection::Descending,
            SortDirection::Descending => SortDirection::Ascending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodLogEntry {
    pub timestamp: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub name: String,
    pub namespace: String,
    pub reason: String,
    pub message: String,
    pub event_type: String,
    pub count: i32,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub source: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_type_all_contains_all_unique_variants() {
        let all = ResourceType::all();
        assert_eq!(all.len(), 15);

        use std::collections::HashSet;
        let unique: HashSet<_> = all.iter().copied().collect();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn resource_type_mappings_are_consistent_for_selected_variants() {
        assert_eq!(ResourceType::Pods.display_name(), "Pods");
        assert_eq!(ResourceType::Pods.api_name(), "pods");
        assert_eq!(ResourceType::Pods.api_kind(), "Pod");
        assert!(ResourceType::Pods.is_namespaced());

        assert_eq!(ResourceType::Namespaces.display_name(), "Namespaces");
        assert_eq!(ResourceType::Namespaces.api_name(), "namespaces");
        assert_eq!(ResourceType::Namespaces.api_kind(), "Namespace");
        assert!(!ResourceType::Namespaces.is_namespaced());

        assert_eq!(
            ResourceType::HorizontalPodAutoscalers.display_name(),
            "HPA"
        );
        assert_eq!(
            ResourceType::VerticalPodAutoscalers.display_name(),
            "VPA"
        );
    }

    #[test]
    fn sort_direction_toggle_flips_both_ways() {
        assert_eq!(SortDirection::Ascending.toggle(), SortDirection::Descending);
        assert_eq!(SortDirection::Descending.toggle(), SortDirection::Ascending);
    }

    #[test]
    fn defaults_match_expected_values() {
        assert_eq!(ConnectionStatus::default(), ConnectionStatus::Connecting);
        assert_eq!(SortDirection::default(), SortDirection::Ascending);
        assert_eq!(ResourceType::default(), ResourceType::Pods);
    }
}
