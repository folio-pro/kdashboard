use anyhow::Result;
use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use kube::api::{DynamicObject, ListParams};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};

use super::helpers::{api_resource_for_kind, dynamic_api_for_resource};
use crate::k8s::client::get_client;

/// Summary of a Deployment revision surfaced in the UI for rollback selection.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RevisionInfo {
    pub revision: u64,
    pub name: String,
    pub created_at: Option<String>,
    pub images: Vec<String>,
    pub replicas: i32,
    pub is_current: bool,
}

/// Extract the revision number from a ReplicaSet's annotations. Returns 0 if missing or unparseable.
fn rs_revision(rs: &ReplicaSet) -> u64 {
    rs.metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("deployment.kubernetes.io/revision"))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Container images from a ReplicaSet's pod template.
fn rs_images(rs: &ReplicaSet) -> Vec<String> {
    rs.spec
        .as_ref()
        .and_then(|s| s.template.as_ref())
        .and_then(|t| t.spec.as_ref())
        .map(|pod_spec| {
            pod_spec
                .containers
                .iter()
                .filter_map(|c| c.image.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch ReplicaSets owned by the given Deployment, sorted by revision descending (newest first).
///
/// Matches ReplicaSets by the Deployment's UID (not name) so orphaned RSes left behind by a
/// previously deleted Deployment of the same name are never mistaken for revisions of the
/// current one.
async fn fetch_sorted_revisions(
    client: &Client,
    name: &str,
    namespace: &str,
) -> Result<Vec<ReplicaSet>> {
    let deploy_api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let deployment = deploy_api.get(name).await?;
    let deployment_uid = deployment
        .metadata
        .uid
        .ok_or_else(|| anyhow::anyhow!("Deployment {} has no UID", name))?;

    let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
    let rs_list = rs_api.list(&ListParams::default()).await?;

    let mut owned: Vec<ReplicaSet> = rs_list
        .items
        .into_iter()
        .filter(|rs| {
            rs.metadata.owner_references.as_ref().is_some_and(|refs| {
                refs.iter()
                    .any(|r| r.controller == Some(true) && r.uid == deployment_uid)
            })
        })
        .collect();

    owned.sort_by_key(|rs| std::cmp::Reverse(rs_revision(rs)));
    Ok(owned)
}

/// Apply (create or update) a resource from raw YAML using server-side apply.
pub async fn apply_resource_yaml(yaml_str: &str) -> Result<String> {
    let client = get_client().await?;

    // Parse YAML once into a JSON Value -- used for extracting fields and as the patch body.
    let mut data: serde_json::Value =
        serde_yaml::from_str(yaml_str).map_err(|e| anyhow::anyhow!("Invalid YAML: {}", e))?;

    // Strip server-generated metadata fields that the API rejects in apply requests.
    if let Some(metadata) = data.pointer_mut("/metadata") {
        if let Some(obj) = metadata.as_object_mut() {
            for key in &[
                "managedFields",
                "resourceVersion",
                "uid",
                "creationTimestamp",
                "generation",
                "selfLink",
            ] {
                obj.remove(*key);
            }
        }
    }

    let kind_str = data
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("YAML must contain a 'kind' field"))?;

    let name = data
        .pointer("/metadata/name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("YAML must contain metadata.name"))?
        .to_owned();

    let namespace = data
        .pointer("/metadata/namespace")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_owned();

    let (ar, cluster_scoped) = api_resource_for_kind(kind_str)?;

    let api = dynamic_api_for_resource(client, &ar, cluster_scoped, &namespace);

    // Use server-side apply with force to allow field manager changes.
    use kube::api::{Patch, PatchParams};
    let patch_params = PatchParams::apply("kdashboard").force();

    let result = api.patch(&name, &patch_params, &Patch::Apply(data)).await?;
    let updated_yaml = serde_yaml::to_string(&result)?;
    Ok(updated_yaml)
}

/// Delete a single resource by kind, name, and namespace.
pub async fn delete_resource(
    kind: &str,
    name: &str,
    namespace: &str,
    uid: Option<&str>,
    resource_version: Option<&str>,
) -> Result<()> {
    let client = get_client().await?;
    let (ar, cluster_scoped) = api_resource_for_kind(kind)?;

    let api = dynamic_api_for_resource(client, &ar, cluster_scoped, namespace);

    let mut delete_params = kube::api::DeleteParams::default();
    if uid.is_some() || resource_version.is_some() {
        delete_params.preconditions = Some(kube::api::Preconditions {
            uid: uid.map(ToOwned::to_owned),
            resource_version: resource_version.map(ToOwned::to_owned),
        });
    }

    api.delete(name, &delete_params).await?;
    Ok(())
}

/// Scale a workload (Deployment, StatefulSet, ReplicaSet) to the given replica count.
pub async fn scale_workload(kind: &str, name: &str, namespace: &str, replicas: u32) -> Result<()> {
    let client = get_client().await?;
    let (ar, _) = api_resource_for_kind(kind)?;
    let api: Api<DynamicObject> = Api::namespaced_with(client, namespace, &ar);
    let patch = serde_json::json!({
        "spec": { "replicas": replicas }
    });
    let pp = kube::api::PatchParams::default();
    api.patch(name, &pp, &kube::api::Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Restart a workload by patching the pod template annotation with the current timestamp.
pub async fn restart_workload(kind: &str, name: &str, namespace: &str) -> Result<()> {
    let client = get_client().await?;
    let (ar, _) = api_resource_for_kind(kind)?;
    let api: Api<DynamicObject> = Api::namespaced_with(client, namespace, &ar);
    let now = chrono::Utc::now().to_rfc3339();
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": now
                    }
                }
            }
        }
    });
    let pp = kube::api::PatchParams::default();
    api.patch(name, &pp, &kube::api::Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// List all revisions (ReplicaSets) belonging to a Deployment, newest first.
///
/// The revision with the highest number that has running pods is marked `is_current`.
/// If no ReplicaSet is running (e.g. the Deployment is paused with 0 replicas), the
/// newest revision is flagged as current so the UI can still distinguish it.
pub async fn list_deployment_revisions(name: &str, namespace: &str) -> Result<Vec<RevisionInfo>> {
    let client = get_client().await?;
    let sorted = fetch_sorted_revisions(&client, name, namespace).await?;

    let current_idx = sorted
        .iter()
        .position(|rs| rs.status.as_ref().is_some_and(|s| s.replicas > 0))
        .unwrap_or(0);

    Ok(sorted
        .iter()
        .enumerate()
        .map(|(idx, rs)| RevisionInfo {
            revision: rs_revision(rs),
            name: rs.metadata.name.clone().unwrap_or_default(),
            created_at: rs
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|t| t.0.to_rfc3339()),
            images: rs_images(rs),
            replicas: rs.status.as_ref().map(|s| s.replicas).unwrap_or(0),
            is_current: idx == current_idx,
        })
        .collect())
}

/// Rollback a Deployment to a previous revision by copying the pod template from a target ReplicaSet.
pub async fn rollback_deployment(
    name: &str,
    namespace: &str,
    revision: Option<u64>,
) -> Result<String> {
    let client = get_client().await?;
    let sorted_rs = fetch_sorted_revisions(&client, name, namespace).await?;

    if sorted_rs.is_empty() {
        return Err(anyhow::anyhow!(
            "No ReplicaSets found for deployment {}",
            name
        ));
    }

    let target_rs = if let Some(rev) = revision {
        sorted_rs
            .iter()
            .find(|rs| rs_revision(rs) == rev)
            .ok_or_else(|| anyhow::anyhow!("Revision {} not found", rev))?
    } else {
        sorted_rs
            .get(1)
            .ok_or_else(|| anyhow::anyhow!("No previous revision found"))?
    };

    let target_rev = rs_revision(target_rs);

    let target_template = target_rs
        .spec
        .as_ref()
        .and_then(|s| serde_json::to_value(&s.template).ok())
        .ok_or_else(|| anyhow::anyhow!("Could not extract template from target ReplicaSet"))?;

    let (ar, _) = api_resource_for_kind("deployment")?;
    let deploy_api: Api<DynamicObject> = Api::namespaced_with(client, namespace, &ar);
    let patch = serde_json::json!({
        "spec": { "template": target_template }
    });
    // PatchParams::force only works with Patch::Apply; rollback uses Merge to
    // only touch spec.template, so force-on-apply is not applicable here.
    let pp = kube::api::PatchParams::default();
    deploy_api
        .patch(name, &pp, &kube::api::Patch::Merge(&patch))
        .await?;

    Ok(format!("Rolled back to revision {}", target_rev))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use std::collections::BTreeMap;

    fn rs_with_revision(rev: Option<&str>) -> ReplicaSet {
        let annotations = rev.map(|v| {
            let mut m = BTreeMap::new();
            m.insert(
                "deployment.kubernetes.io/revision".to_string(),
                v.to_string(),
            );
            m
        });
        ReplicaSet {
            metadata: ObjectMeta {
                annotations,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn rs_revision_parses_valid_annotation() {
        let rs = rs_with_revision(Some("7"));
        assert_eq!(rs_revision(&rs), 7);
    }

    #[test]
    fn rs_revision_returns_zero_when_missing() {
        let rs = rs_with_revision(None);
        assert_eq!(rs_revision(&rs), 0);
    }

    #[test]
    fn rs_revision_returns_zero_when_unparseable() {
        let rs = rs_with_revision(Some("not-a-number"));
        assert_eq!(rs_revision(&rs), 0);
    }

    #[test]
    fn rs_revision_handles_large_numbers() {
        let rs = rs_with_revision(Some("18446744073709551615")); // u64::MAX
        assert_eq!(rs_revision(&rs), u64::MAX);
    }
}
