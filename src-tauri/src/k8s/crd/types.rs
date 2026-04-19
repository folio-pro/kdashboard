use serde::{Deserialize, Serialize};

use super::super::resources::Resource;

// ---------------------------------------------------------------------------
// CRD info returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrdInfo {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub scope: String, // "Namespaced" or "Cluster"
    pub short_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrdGroup {
    pub group: String,
    pub resources: Vec<CrdInfo>,
}

/// Column definition extracted from CRD additionalPrinterColumns or heuristics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrdColumn {
    pub name: String,
    pub json_path: String,
    pub column_type: String, // "string", "integer", "date", etc.
    pub description: String,
}

/// Result of listing CRD resources with smart columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrdResourceList {
    pub items: Vec<Resource>,
    pub columns: Vec<CrdColumn>,
}

// ---------------------------------------------------------------------------
// Status conditions extraction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusCondition {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_transition_time: Option<String>,
}

/// Extract .status.conditions from a resource if present.
pub fn extract_conditions(resource: &Resource) -> Vec<StatusCondition> {
    resource
        .status
        .as_ref()
        .and_then(|s| s.get("conditions"))
        .and_then(|c| c.as_array())
        .map(|conditions| {
            conditions
                .iter()
                .filter_map(|c| {
                    let type_ = c.get("type")?.as_str()?.to_string();
                    let status = c.get("status")?.as_str()?.to_string();
                    Some(StatusCondition {
                        type_,
                        status,
                        reason: c
                            .get("reason")
                            .and_then(|r| r.as_str())
                            .map(|s| s.to_string()),
                        message: c
                            .get("message")
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string()),
                        last_transition_time: c
                            .get("lastTransitionTime")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
