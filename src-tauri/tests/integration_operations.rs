//! Integration tests for mutation operations in `k8s::resources::operations`.
//!
//! Exercises the write paths against a real Kind cluster:
//!   - list_deployment_revisions (including the orphan-ReplicaSet regression)
//!   - rollback_deployment (with and without an explicit revision)
//!   - scale_workload (including zero)
//!   - restart_workload
//!   - apply_resource_yaml (strip server-generated fields)
//!
//! Each test creates resources under unique names inside the shared test
//! namespace, so tests are hermetic even when run back-to-back in the same
//! cluster. The script (`scripts/integration-test.sh`) runs them serially
//! (`--test-threads=1`).

#![cfg(feature = "integration")]

use std::collections::BTreeMap;
use std::env;
use std::time::Duration;

use k8s_openapi::api::apps::v1::{Deployment, DeploymentSpec, ReplicaSet};
use k8s_openapi::api::core::v1::{
    ConfigMap, Container, ContainerPort, PodSpec, PodTemplateSpec, ResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, OwnerReference};
use kube::api::{Api, DeleteParams, ObjectMeta, Patch, PatchParams, PostParams};
use kube::Client;

use kdashboard_lib::k8s::{
    client,
    resources::{
        apply_resource_yaml, delete_resource, list_deployment_revisions, restart_workload,
        rollback_deployment, scale_workload,
    },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn test_namespace() -> String {
    env::var("KDASH_TEST_NAMESPACE").unwrap_or_else(|_| "kdash-test".into())
}

fn fresh_client() {
    client::reset_client();
}

async fn kube_client() -> Client {
    kdashboard_lib::k8s::client::get_client()
        .await
        .expect("get_client should succeed")
}

fn labels(name: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert("app".to_string(), name.to_string());
    m
}

fn container_resources() -> ResourceRequirements {
    let mut requests = BTreeMap::new();
    requests.insert("cpu".to_string(), Quantity("10m".to_string()));
    requests.insert("memory".to_string(), Quantity("16Mi".to_string()));
    let mut limits = BTreeMap::new();
    limits.insert("cpu".to_string(), Quantity("50m".to_string()));
    limits.insert("memory".to_string(), Quantity("64Mi".to_string()));
    ResourceRequirements {
        requests: Some(requests),
        limits: Some(limits),
        ..Default::default()
    }
}

/// Build a minimal nginx Deployment named `name` with the given image and replica count.
fn build_deployment(name: &str, ns: &str, image: &str, replicas: i32) -> Deployment {
    Deployment {
        metadata: ObjectMeta {
            name: Some(name.to_string()),
            namespace: Some(ns.to_string()),
            labels: Some(labels(name)),
            ..Default::default()
        },
        spec: Some(DeploymentSpec {
            replicas: Some(replicas),
            selector: LabelSelector {
                match_labels: Some(labels(name)),
                ..Default::default()
            },
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(labels(name)),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    containers: vec![Container {
                        name: "nginx".to_string(),
                        image: Some(image.to_string()),
                        ports: Some(vec![ContainerPort {
                            container_port: 80,
                            ..Default::default()
                        }]),
                        resources: Some(container_resources()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Best-effort deletion of a Deployment — ignore errors.
async fn cleanup_deployment(client: &Client, ns: &str, name: &str) {
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let _ = api.delete(name, &DeleteParams::background()).await;
}

/// Best-effort deletion of a ReplicaSet — ignore errors.
async fn cleanup_replicaset(client: &Client, ns: &str, name: &str) {
    let api: Api<ReplicaSet> = Api::namespaced(client.clone(), ns);
    let _ = api.delete(name, &DeleteParams::background()).await;
}

/// Best-effort deletion of a ConfigMap — ignore errors.
async fn cleanup_configmap(client: &Client, ns: &str, name: &str) {
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), ns);
    let _ = api.delete(name, &DeleteParams::background()).await;
}

/// Create a Deployment and wait until its current generation is observed and all replicas report available.
async fn create_and_wait_deployment(
    client: &Client,
    ns: &str,
    deploy: Deployment,
    timeout_s: u64,
) {
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let created = api
        .create(&PostParams::default(), &deploy)
        .await
        .expect("create deployment should succeed");
    let name = created.metadata.name.clone().unwrap();
    wait_for_rollout(client, ns, &name, timeout_s).await;
}

/// Clean slate + create a single-replica nginx:1.27 Deployment and wait for rollout.
async fn setup_basic_deployment(client: &Client, ns: &str, name: &str) {
    cleanup_deployment(client, ns, name).await;
    create_and_wait_deployment(
        client,
        ns,
        build_deployment(name, ns, "nginx:1.27-alpine", 1),
        90,
    )
    .await;
}

/// Poll a Deployment until rollout is complete or we time out.
async fn wait_for_rollout(client: &Client, ns: &str, name: &str, timeout_s: u64) {
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_s);
    loop {
        if let Ok(d) = api.get(name).await {
            let generation = d.metadata.generation.unwrap_or(0);
            let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
            if let Some(status) = d.status.as_ref() {
                let observed = status.observed_generation.unwrap_or(0);
                let available = status.available_replicas.unwrap_or(0);
                let updated = status.updated_replicas.unwrap_or(0);
                if observed >= generation && available == desired && updated == desired {
                    return;
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            panic!("rollout for {} did not complete within {}s", name, timeout_s);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Patch a Deployment's container image and wait for the new rollout to finish.
async fn bump_image_and_wait(client: &Client, ns: &str, name: &str, new_image: &str) {
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "spec": {
                    "containers": [{
                        "name": "nginx",
                        "image": new_image,
                    }]
                }
            }
        }
    });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .expect("patch deployment image should succeed");
    wait_for_rollout(client, ns, name, 90).await;
}

// ---------------------------------------------------------------------------
// list_deployment_revisions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_list_deployment_revisions_returns_sorted_current_flag() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-rev-list";

    let client = kube_client().await;
    cleanup_deployment(&client, &ns, name).await;

    // Revision 1
    create_and_wait_deployment(
        &client,
        &ns,
        build_deployment(name, &ns, "nginx:1.27-alpine", 2),
        90,
    )
    .await;

    // Revision 2 — bump image
    bump_image_and_wait(&client, &ns, name, "nginx:1.25-alpine").await;

    let revisions = list_deployment_revisions(name, &ns)
        .await
        .expect("list_deployment_revisions should succeed");

    assert!(
        revisions.len() >= 2,
        "expected at least 2 revisions, got {}",
        revisions.len()
    );

    // Sorted newest-first.
    for pair in revisions.windows(2) {
        assert!(
            pair[0].revision >= pair[1].revision,
            "revisions should be sorted descending: {} !>= {}",
            pair[0].revision,
            pair[1].revision
        );
    }

    // Exactly one revision is flagged current.
    let current_count = revisions.iter().filter(|r| r.is_current).count();
    assert_eq!(
        current_count, 1,
        "exactly one revision should be marked current, got {}",
        current_count
    );

    // The current revision is the one with running pods (replicas > 0).
    let current = revisions.iter().find(|r| r.is_current).unwrap();
    assert!(
        current.replicas > 0,
        "current revision should have running pods, got replicas={}",
        current.replicas
    );

    // The newest revision should contain the post-bump image.
    let newest = &revisions[0];
    assert!(
        newest.images.iter().any(|i| i.contains("1.25")),
        "newest revision should reference nginx:1.25, got images={:?}",
        newest.images
    );

    cleanup_deployment(&client, &ns, name).await;
}

#[tokio::test]
async fn integration_list_deployment_revisions_filters_orphaned_rs() {
    // Regression guard for d20dfb7: a ReplicaSet whose owner name matches the
    // Deployment but whose UID refers to a deleted predecessor must NOT be
    // reported as a revision of the current Deployment.
    fresh_client();
    let ns = test_namespace();
    let name = "op-rev-orphan";

    let client = kube_client().await;

    // Clean slate.
    cleanup_deployment(&client, &ns, name).await;
    // Also remove any leftover orphan from a previous run.
    let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), &ns);
    if let Ok(list) = rs_api.list(&Default::default()).await {
        for rs in list.items {
            if rs
                .metadata
                .name
                .as_deref()
                .map(|n| n.starts_with(&format!("{}-orphan", name)))
                .unwrap_or(false)
            {
                if let Some(n) = rs.metadata.name {
                    cleanup_replicaset(&client, &ns, &n).await;
                }
            }
        }
    }

    // Create an orphan ReplicaSet whose ownerReferences point at a bogus UID
    // but whose name matches the Deployment we are about to create. A
    // name-based filter would incorrectly pick this up.
    let orphan_name = format!("{}-orphan-abc", name);
    let mut orphan_annotations = BTreeMap::new();
    orphan_annotations.insert(
        "deployment.kubernetes.io/revision".to_string(),
        "99".to_string(),
    );
    let orphan = ReplicaSet {
        metadata: ObjectMeta {
            name: Some(orphan_name.clone()),
            namespace: Some(ns.clone()),
            labels: Some(labels(name)),
            annotations: Some(orphan_annotations),
            owner_references: Some(vec![OwnerReference {
                api_version: "apps/v1".to_string(),
                kind: "Deployment".to_string(),
                name: name.to_string(),
                uid: "00000000-0000-0000-0000-deadbeefcafe".to_string(),
                controller: Some(true),
                block_owner_deletion: Some(true),
            }]),
            ..Default::default()
        },
        spec: Some(k8s_openapi::api::apps::v1::ReplicaSetSpec {
            replicas: Some(0),
            selector: LabelSelector {
                match_labels: Some(labels(name)),
                ..Default::default()
            },
            template: Some(PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(labels(name)),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    containers: vec![Container {
                        name: "nginx".to_string(),
                        image: Some("nginx:1.23-alpine".to_string()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    rs_api
        .create(&PostParams::default(), &orphan)
        .await
        .expect("create orphan ReplicaSet should succeed");

    // Create the real Deployment; kube will generate its own ReplicaSet.
    create_and_wait_deployment(
        &client,
        &ns,
        build_deployment(name, &ns, "nginx:1.27-alpine", 1),
        90,
    )
    .await;

    let revisions = list_deployment_revisions(name, &ns)
        .await
        .expect("list_deployment_revisions should succeed");

    assert!(
        !revisions.iter().any(|r| r.name == orphan_name),
        "orphan ReplicaSet '{}' should be filtered out by UID match, got {:?}",
        orphan_name,
        revisions.iter().map(|r| &r.name).collect::<Vec<_>>()
    );
    assert!(
        !revisions.iter().any(|r| r.revision == 99),
        "bogus revision 99 from orphan must not leak into revision list"
    );

    cleanup_replicaset(&client, &ns, &orphan_name).await;
    cleanup_deployment(&client, &ns, name).await;
}

// ---------------------------------------------------------------------------
// rollback_deployment
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_rollback_deployment_to_specific_revision() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-rollback-rev";

    let client = kube_client().await;
    setup_basic_deployment(&client, &ns, name).await;
    bump_image_and_wait(&client, &ns, name, "nginx:1.25-alpine").await;

    let revisions = list_deployment_revisions(name, &ns).await.unwrap();
    let original_rev = revisions
        .iter()
        .find(|r| r.images.iter().any(|i| i.contains("1.27")))
        .expect("original revision should still be listed")
        .revision;

    let msg = rollback_deployment(name, &ns, Some(original_rev))
        .await
        .expect("rollback to specific revision should succeed");
    assert!(
        msg.contains(&original_rev.to_string()),
        "message should mention target revision, got: {}",
        msg
    );

    // Wait for the rollback rollout to settle, then confirm the live image.
    wait_for_rollout(&client, &ns, name, 90).await;

    let api: Api<Deployment> = Api::namespaced(client.clone(), &ns);
    let deploy = api.get(name).await.unwrap();
    let image = deploy
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|p| p.containers.first())
        .and_then(|c| c.image.clone())
        .unwrap_or_default();
    assert!(
        image.contains("1.27"),
        "after rollback the pod template should reference nginx:1.27, got '{}'",
        image
    );

    cleanup_deployment(&client, &ns, name).await;
}

#[tokio::test]
async fn integration_rollback_deployment_without_revision_uses_previous() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-rollback-prev";

    let client = kube_client().await;
    setup_basic_deployment(&client, &ns, name).await;
    bump_image_and_wait(&client, &ns, name, "nginx:1.25-alpine").await;

    let msg = rollback_deployment(name, &ns, None)
        .await
        .expect("rollback without revision should succeed");
    assert!(msg.starts_with("Rolled back to revision "), "got: {}", msg);

    wait_for_rollout(&client, &ns, name, 90).await;

    let api: Api<Deployment> = Api::namespaced(client.clone(), &ns);
    let deploy = api.get(name).await.unwrap();
    let image = deploy
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|p| p.containers.first())
        .and_then(|c| c.image.clone())
        .unwrap_or_default();
    assert!(
        image.contains("1.27"),
        "default rollback should bring back the prior image nginx:1.27, got '{}'",
        image
    );

    cleanup_deployment(&client, &ns, name).await;
}

#[tokio::test]
async fn integration_rollback_deployment_to_nonexistent_revision_errors() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-rollback-nope";

    let client = kube_client().await;
    setup_basic_deployment(&client, &ns, name).await;

    let result = rollback_deployment(name, &ns, Some(9999)).await;
    let err = result.expect_err("rollback to a nonexistent revision should fail");
    let msg = err.to_string();
    assert!(
        msg.contains("9999") || msg.to_lowercase().contains("not found"),
        "error should mention the missing revision, got: {}",
        msg
    );

    cleanup_deployment(&client, &ns, name).await;
}

// ---------------------------------------------------------------------------
// scale_workload
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_scale_workload_changes_replicas() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-scale";

    let client = kube_client().await;
    setup_basic_deployment(&client, &ns, name).await;

    scale_workload("deployment", name, &ns, 3)
        .await
        .expect("scale_workload should succeed");

    let api: Api<Deployment> = Api::namespaced(client.clone(), &ns);
    let deploy = api.get(name).await.unwrap();
    let replicas = deploy.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    assert_eq!(replicas, 3, "spec.replicas should be 3 after scale");

    cleanup_deployment(&client, &ns, name).await;
}

#[tokio::test]
async fn integration_scale_workload_to_zero() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-scale-zero";

    let client = kube_client().await;
    setup_basic_deployment(&client, &ns, name).await;

    scale_workload("deployment", name, &ns, 0)
        .await
        .expect("scale to zero should succeed");

    let api: Api<Deployment> = Api::namespaced(client.clone(), &ns);
    let deploy = api.get(name).await.unwrap();
    let replicas = deploy.spec.as_ref().and_then(|s| s.replicas).unwrap_or(-1);
    assert_eq!(
        replicas, 0,
        "spec.replicas should be 0 after scaling to zero"
    );

    cleanup_deployment(&client, &ns, name).await;
}

// ---------------------------------------------------------------------------
// restart_workload
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_restart_workload_sets_annotation() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-restart";

    let client = kube_client().await;
    setup_basic_deployment(&client, &ns, name).await;

    restart_workload("deployment", name, &ns)
        .await
        .expect("restart_workload should succeed");

    let api: Api<Deployment> = Api::namespaced(client.clone(), &ns);
    let deploy = api.get(name).await.unwrap();
    let annotations = deploy
        .spec
        .as_ref()
        .and_then(|s| s.template.metadata.as_ref())
        .and_then(|m| m.annotations.as_ref())
        .expect("pod template should have annotations after restart");
    let stamp = annotations
        .get("kubectl.kubernetes.io/restartedAt")
        .expect("restartedAt annotation should be set");

    let parsed = chrono::DateTime::parse_from_rfc3339(stamp);
    assert!(
        parsed.is_ok(),
        "restartedAt '{}' should parse as RFC3339, err: {:?}",
        stamp,
        parsed.err()
    );

    cleanup_deployment(&client, &ns, name).await;
}

// ---------------------------------------------------------------------------
// apply_resource_yaml
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_apply_resource_yaml_strips_server_generated_fields() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-apply-cm";

    let client = kube_client().await;
    cleanup_configmap(&client, &ns, name).await;

    // YAML with server-generated fields that the API rejects if submitted.
    let yaml = format!(
        r#"apiVersion: v1
kind: ConfigMap
metadata:
  name: {name}
  namespace: {ns}
  uid: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  resourceVersion: "999999"
  generation: 42
  creationTimestamp: "2020-01-01T00:00:00Z"
  managedFields:
    - manager: other
      operation: Update
data:
  greeting: hello
"#,
        name = name,
        ns = ns,
    );

    apply_resource_yaml(&yaml)
        .await
        .expect("apply_resource_yaml should strip server fields and succeed");

    // Confirm the ConfigMap exists and carries our data.
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), &ns);
    let cm = api
        .get(name)
        .await
        .expect("configmap should exist after apply");
    let data = cm.data.as_ref().expect("configmap should have data");
    assert_eq!(
        data.get("greeting").map(|s| s.as_str()),
        Some("hello"),
        "applied configmap should contain the greeting=hello entry"
    );

    // Re-apply with a different value to prove idempotency (server-side apply).
    let yaml_update = format!(
        r#"apiVersion: v1
kind: ConfigMap
metadata:
  name: {name}
  namespace: {ns}
data:
  greeting: hola
"#,
        name = name,
        ns = ns,
    );
    apply_resource_yaml(&yaml_update)
        .await
        .expect("re-apply should succeed");

    let cm2 = api.get(name).await.unwrap();
    let data2 = cm2.data.as_ref().unwrap();
    assert_eq!(
        data2.get("greeting").map(|s| s.as_str()),
        Some("hola"),
        "re-apply should update the ConfigMap"
    );

    cleanup_configmap(&client, &ns, name).await;
}

// ---------------------------------------------------------------------------
// delete_resource — precondition mismatch path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_delete_resource_with_uid_precondition_mismatch_errors() {
    fresh_client();
    let ns = test_namespace();
    let name = "op-delete-precond";

    let client = kube_client().await;
    cleanup_configmap(&client, &ns, name).await;

    // Create a ConfigMap we can target.
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), &ns);
    let mut data = BTreeMap::new();
    data.insert("k".to_string(), "v".to_string());
    let cm = ConfigMap {
        metadata: ObjectMeta {
            name: Some(name.to_string()),
            namespace: Some(ns.clone()),
            ..Default::default()
        },
        data: Some(data),
        ..Default::default()
    };
    api.create(&PostParams::default(), &cm).await.unwrap();

    // Issue delete with an intentionally-wrong UID precondition.
    let bogus_uid = "00000000-0000-0000-0000-000000000001";
    let res = delete_resource("configmap", name, &ns, Some(bogus_uid), None).await;

    assert!(
        res.is_err(),
        "delete_resource with a mismatched UID precondition should fail"
    );

    // Sanity: the target still exists because the delete was rejected.
    assert!(
        api.get(name).await.is_ok(),
        "configmap should still exist after a rejected delete"
    );

    // Happy-path delete with the real UID precondition.
    let real = api.get(name).await.unwrap();
    let real_uid = real.metadata.uid.clone().unwrap();
    delete_resource("configmap", name, &ns, Some(&real_uid), None)
        .await
        .expect("delete with correct UID should succeed");

    // Ensure it is actually gone (may take a moment for kube to finalize).
    let mut gone = false;
    for _ in 0..10 {
        if api.get(name).await.is_err() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(gone, "configmap should be deleted after matching-UID delete");
}
