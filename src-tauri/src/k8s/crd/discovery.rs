use anyhow::Result;
use kube::discovery::{self, Scope};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Semaphore;

use super::super::client::get_client;
use super::types::{CrdGroup, CrdInfo};

// ---------------------------------------------------------------------------
// Sensitive field deny-list for smart column extraction
// ---------------------------------------------------------------------------

pub(crate) const SENSITIVE_FIELD_PATTERNS: &[&str] = &[
    "password",
    "secret",
    "token",
    "key",
    "credential",
    "apikey",
    "certificate",
    "private",
    "passphrase",
];

pub(crate) fn is_sensitive_field(name: &str) -> bool {
    let lower = name.to_lowercase();
    SENSITIVE_FIELD_PATTERNS.iter().any(|p| lower.contains(p))
}

// ---------------------------------------------------------------------------
// Shared semaphore for API call concurrency limiting
// ---------------------------------------------------------------------------

static API_SEMAPHORE: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();

pub(crate) fn api_semaphore() -> Arc<Semaphore> {
    API_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(20)))
        .clone()
}

// ---------------------------------------------------------------------------
// CRD Discovery
// ---------------------------------------------------------------------------

/// Discover all CRDs in the cluster, grouped by API group.
/// Excludes built-in K8s API groups (core, apps, batch, etc.).
pub async fn discover_crds() -> Result<Vec<CrdGroup>> {
    let client = get_client().await?;

    let discovery = discovery::Discovery::new(client).run().await?;

    let builtin_groups: &[&str] = &[
        "",
        "apps",
        "batch",
        "autoscaling",
        "networking.k8s.io",
        "policy",
        "rbac.authorization.k8s.io",
        "storage.k8s.io",
        "coordination.k8s.io",
        "discovery.k8s.io",
        "events.k8s.io",
        "flowcontrol.apiserver.k8s.io",
        "node.k8s.io",
        "scheduling.k8s.io",
        "certificates.k8s.io",
        "admissionregistration.k8s.io",
        "apiextensions.k8s.io",
        "apiregistration.k8s.io",
        "authentication.k8s.io",
        "authorization.k8s.io",
        "internal.apiserver.k8s.io",
    ];

    let mut groups_map: HashMap<String, Vec<CrdInfo>> = HashMap::new();

    for group in discovery.groups() {
        let group_name = group.name();
        if builtin_groups.contains(&group_name) {
            continue;
        }

        for (ar, caps) in group.recommended_resources() {
            let scope = match caps.scope {
                Scope::Cluster => "Cluster",
                Scope::Namespaced => "Namespaced",
            };

            let crd_info = CrdInfo {
                group: ar.group.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                plural: ar.plural.clone(),
                scope: scope.to_string(),
                short_names: vec![], // Discovery API doesn't provide short names
            };

            groups_map
                .entry(group_name.to_string())
                .or_default()
                .push(crd_info);
        }
    }

    let mut groups: Vec<CrdGroup> = groups_map
        .into_iter()
        .map(|(group, mut resources)| {
            resources.sort_by(|a, b| a.kind.cmp(&b.kind));
            CrdGroup { group, resources }
        })
        .collect();

    groups.sort_by(|a, b| a.group.cmp(&b.group));

    Ok(groups)
}
