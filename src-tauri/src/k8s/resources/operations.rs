use anyhow::Result;
use k8s_openapi::api::apps::v1::ReplicaSet;
use kube::api::{DynamicObject, ListParams};
use kube::Api;

use super::helpers::{api_resource_for_kind, dynamic_api_for_resource};
use crate::k8s::client::get_client;

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

/// Rollback a Deployment to a previous revision by copying the pod template from a target ReplicaSet.
pub async fn rollback_deployment(
    name: &str,
    namespace: &str,
    revision: Option<u64>,
) -> Result<String> {
    let client = get_client().await?;

    // Get all ReplicaSets in the namespace
    let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default();
    let rs_list = rs_api.list(&lp).await?;

    // Find ReplicaSets owned by this deployment and sort by revision (descending)
    let mut sorted_rs: Vec<_> = rs_list
        .items
        .iter()
        .filter(|rs| {
            rs.metadata.owner_references.as_ref().is_some_and(|refs| {
                refs.iter()
                    .any(|r| r.kind == "Deployment" && r.name == name)
            })
        })
        .collect();

    if sorted_rs.is_empty() {
        return Err(anyhow::anyhow!(
            "No ReplicaSets found for deployment {}",
            name
        ));
    }

    sorted_rs.sort_by(|a, b| {
        let rev_a: u64 = a
            .metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get("deployment.kubernetes.io/revision"))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let rev_b: u64 = b
            .metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get("deployment.kubernetes.io/revision"))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        rev_b.cmp(&rev_a)
    });

    // Target is either the specified revision or the previous one
    let target_rs = if let Some(rev) = revision {
        sorted_rs
            .iter()
            .find(|rs| {
                rs.metadata
                    .annotations
                    .as_ref()
                    .and_then(|a| a.get("deployment.kubernetes.io/revision"))
                    .and_then(|v| v.parse::<u64>().ok())
                    == Some(rev)
            })
            .ok_or_else(|| anyhow::anyhow!("Revision {} not found", rev))?
    } else {
        sorted_rs
            .get(1)
            .ok_or_else(|| anyhow::anyhow!("No previous revision found"))?
    };

    let target_rev = target_rs
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("deployment.kubernetes.io/revision"))
        .cloned()
        .unwrap_or_default();

    // Extract pod template from target RS and patch the deployment
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
    let pp = kube::api::PatchParams::apply("kdashboard").force();
    deploy_api
        .patch(name, &pp, &kube::api::Patch::Merge(&patch))
        .await?;

    Ok(format!("Rolled back to revision {}", target_rev))
}
