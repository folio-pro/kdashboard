use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticIssue {
    pub severity: String, // "critical" | "warning" | "info"
    pub category: String, // "crash" | "oom" | "image" | "resources" | "scheduling" | "readiness"
    pub title: String,
    pub detail: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticResult {
    pub resource_uid: String,
    pub resource_kind: String,
    pub resource_name: String,
    pub health: String, // "healthy" | "degraded" | "unhealthy"
    pub issues: Vec<DiagnosticIssue>,
    pub checked_at: String,
}
