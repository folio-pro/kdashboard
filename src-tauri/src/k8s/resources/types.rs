use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Generic resource representation sent to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResourceMetadata {
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub uid: Option<String>,
    pub resource_version: Option<String>,
    pub labels: Option<BTreeMap<String, String>>,
    pub annotations: Option<BTreeMap<String, String>>,
    pub creation_timestamp: Option<String>,
    pub owner_references: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub api_version: String,
    pub kind: String,
    pub metadata: ResourceMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Only populated for Secrets (the Secret type field).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceList {
    pub items: Vec<Resource>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventItem {
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub involved_object: Option<serde_json::Value>,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub count: Option<i32>,
    pub source: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Namespace info
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamespaceInfo {
    pub namespace: String,
    pub resource_quotas: Vec<serde_json::Value>,
    pub limit_ranges: Vec<serde_json::Value>,
    pub resource_counts: std::collections::HashMap<String, u32>,
}
