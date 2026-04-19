//! Integration tests for kdashboard K8s operations.
//!
//! These tests run against a real (ephemeral) Kind cluster.
//! Run via: `./scripts/integration-test.sh`
//!
//! Required env vars:
//!   KDASH_TEST_CONTEXT   - the kubectl context to use (e.g. "kind-kdash-integration")
//!   KDASH_TEST_NAMESPACE - the namespace with seeded resources (e.g. "kdash-test")

#![cfg(feature = "integration")]

use kdashboard_lib::k8s::{client, context, resources};
use std::env;

/// Get the test namespace from env, or skip the test.
fn test_namespace() -> String {
    env::var("KDASH_TEST_NAMESPACE").unwrap_or_else(|_| "kdash-test".into())
}

/// Get the test context from env.
fn test_context() -> String {
    env::var("KDASH_TEST_CONTEXT").unwrap_or_else(|_| "kind-kdash-integration".into())
}

/// Reset the global K8s client so a fresh connection is built.
/// Must be called before each async test to avoid stale connections
/// from a previous tokio runtime.
fn fresh_client() {
    client::reset_client();
}

// ---------------------------------------------------------------------------
// Context tests (sync — no client needed)
// ---------------------------------------------------------------------------

#[test]
fn integration_list_contexts_returns_kind_cluster() {
    let contexts = context::list_contexts().expect("list_contexts should succeed");
    let expected = test_context();
    assert!(
        contexts.contains(&expected),
        "Expected context '{}' in {:?}",
        expected,
        contexts
    );
}

#[test]
fn integration_get_current_context() {
    let current = context::get_current_context().expect("get_current_context should succeed");
    assert!(!current.is_empty(), "current-context should not be empty");
}

// ---------------------------------------------------------------------------
// Namespace tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_list_namespaces_includes_test_ns() {
    fresh_client();
    let namespaces = context::list_namespaces()
        .await
        .expect("list_namespaces should succeed");
    let test_ns = test_namespace();
    assert!(
        namespaces.contains(&test_ns),
        "Expected namespace '{}' in {:?}",
        test_ns,
        namespaces
    );
}

#[tokio::test]
async fn integration_list_namespaces_includes_default() {
    fresh_client();
    let namespaces = context::list_namespaces()
        .await
        .expect("list_namespaces should succeed");
    assert!(
        namespaces.contains(&"default".to_string()),
        "Expected 'default' namespace"
    );
}

// ---------------------------------------------------------------------------
// Resource listing tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_list_pods() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_resources("pods", Some(ns))
        .await
        .expect("list_resources(pods) should succeed");

    assert!(
        !result.items.is_empty(),
        "Expected at least one pod in test namespace (from nginx deployment)"
    );

    let first = &result.items[0];
    assert_eq!(first.kind, "Pod");
    assert_eq!(first.api_version, "v1");
    assert!(first.metadata.name.is_some());
    assert!(first.metadata.uid.is_some());
    assert!(first.spec.is_some());
    assert!(first.status.is_some());
}

#[tokio::test]
async fn integration_list_deployments() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_resources("deployments", Some(ns))
        .await
        .expect("list_resources(deployments) should succeed");

    let deploy = result
        .items
        .iter()
        .find(|r| r.metadata.name.as_deref() == Some("test-nginx"))
        .expect("Expected test-nginx deployment");

    assert_eq!(deploy.kind, "Deployment");
    assert_eq!(deploy.api_version, "apps/v1");

    // Check spec has replicas
    let spec = deploy.spec.as_ref().unwrap();
    assert_eq!(spec.get("replicas").and_then(|v| v.as_u64()), Some(2));
}

#[tokio::test]
async fn integration_list_services() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_resources("services", Some(ns))
        .await
        .expect("list_resources(services) should succeed");

    let svc = result
        .items
        .iter()
        .find(|r| r.metadata.name.as_deref() == Some("test-nginx-svc"))
        .expect("Expected test-nginx-svc service");

    assert_eq!(svc.kind, "Service");
    assert_eq!(svc.api_version, "v1");
}

#[tokio::test]
async fn integration_list_configmaps() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_resources("configmaps", Some(ns))
        .await
        .expect("list_resources(configmaps) should succeed");

    let cm = result
        .items
        .iter()
        .find(|r| r.metadata.name.as_deref() == Some("test-config"))
        .expect("Expected test-config configmap");

    assert_eq!(cm.kind, "ConfigMap");

    // ConfigMaps expose data, not spec
    let data = cm.data.as_ref().expect("configmap should have data");
    assert_eq!(data.get("key1").and_then(|v| v.as_str()), Some("value1"));
    assert_eq!(data.get("key2").and_then(|v| v.as_str()), Some("value2"));
}

#[tokio::test]
async fn integration_list_secrets() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_resources("secrets", Some(ns))
        .await
        .expect("list_resources(secrets) should succeed");

    let secret = result
        .items
        .iter()
        .find(|r| r.metadata.name.as_deref() == Some("test-secret"))
        .expect("Expected test-secret");

    assert_eq!(secret.kind, "Secret");
    assert_eq!(secret.type_.as_deref(), Some("Opaque"));

    // Secret data should be base64-encoded by our list_secrets function
    let data = secret.data.as_ref().expect("secret should have data");
    let username_b64 = data.get("username").and_then(|v| v.as_str()).unwrap();
    let decoded = String::from_utf8(
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, username_b64).unwrap(),
    )
    .unwrap();
    assert_eq!(decoded, "admin");
}

#[tokio::test]
async fn integration_list_jobs() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_resources("jobs", Some(ns))
        .await
        .expect("list_resources(jobs) should succeed");

    let job = result
        .items
        .iter()
        .find(|r| r.metadata.name.as_deref() == Some("test-job"))
        .expect("Expected test-job");

    assert_eq!(job.kind, "Job");
    assert_eq!(job.api_version, "batch/v1");
}

#[tokio::test]
async fn integration_list_namespaces_resource() {
    fresh_client();
    let result = resources::list_resources("namespaces", None)
        .await
        .expect("list_resources(namespaces) should succeed");

    assert!(
        result
            .items
            .iter()
            .any(|r| r.metadata.name.as_deref() == Some("default")),
        "Expected default namespace in list"
    );
    assert!(
        result
            .items
            .iter()
            .any(|r| r.metadata.name.as_deref() == Some("kdash-test")),
        "Expected kdash-test namespace in list"
    );
}

#[tokio::test]
async fn integration_list_nodes() {
    fresh_client();
    let result = resources::list_resources("nodes", None)
        .await
        .expect("list_resources(nodes) should succeed");

    assert!(
        !result.items.is_empty(),
        "Expected at least one node in the cluster"
    );
    assert_eq!(result.items[0].kind, "Node");
}

#[tokio::test]
async fn integration_list_unknown_resource_type_errors() {
    fresh_client();
    let result = resources::list_resources("foobar", Some("default".into())).await;
    assert!(
        result.is_err(),
        "Unknown resource type should return an error"
    );
}

// ---------------------------------------------------------------------------
// Resource YAML tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_get_resource_yaml_deployment() {
    fresh_client();
    let ns = test_namespace();
    let yaml = resources::get_resource_yaml("Deployment", "test-nginx", &ns)
        .await
        .expect("get_resource_yaml should succeed");

    assert!(
        yaml.contains("test-nginx"),
        "YAML should contain resource name"
    );
    assert!(yaml.contains("nginx"), "YAML should reference nginx image");
    assert!(yaml.contains("apiVersion"), "YAML should have apiVersion");
}

#[tokio::test]
async fn integration_get_resource_yaml_configmap() {
    fresh_client();
    let ns = test_namespace();
    let yaml = resources::get_resource_yaml("ConfigMap", "test-config", &ns)
        .await
        .expect("get_resource_yaml should succeed");

    assert!(
        yaml.contains("key1: value1"),
        "YAML should contain configmap data"
    );
}

#[tokio::test]
async fn integration_get_resource_yaml_not_found() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::get_resource_yaml("Pod", "nonexistent-pod-xyz", &ns).await;
    assert!(result.is_err(), "Non-existent resource should return error");
}

// ---------------------------------------------------------------------------
// Resource counts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_get_resource_counts() {
    fresh_client();
    let ns = test_namespace();
    let types = vec![
        "pods".to_string(),
        "deployments".to_string(),
        "services".to_string(),
        "configmaps".to_string(),
        "secrets".to_string(),
    ];

    let counts = resources::get_resource_counts(types, Some(ns))
        .await
        .expect("get_resource_counts should succeed");

    assert!(
        *counts.get("pods").unwrap_or(&0) >= 2,
        "Expected at least 2 pods (from nginx replicas), got {:?}",
        counts.get("pods")
    );
    assert_eq!(
        *counts.get("deployments").unwrap_or(&0),
        1,
        "Expected 1 deployment"
    );
    assert!(
        *counts.get("services").unwrap_or(&0) >= 1,
        "Expected at least 1 service"
    );
    assert!(
        *counts.get("configmaps").unwrap_or(&0) >= 1,
        "Expected at least 1 configmap"
    );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_get_events_for_namespace() {
    fresh_client();
    let ns = test_namespace();
    let events = resources::get_events(Some(ns), None)
        .await
        .expect("get_events should succeed");

    // The deployment should have generated events
    assert!(
        !events.is_empty(),
        "Expected at least one event in the test namespace"
    );

    let first = &events[0];
    assert!(first.type_.is_some(), "Event should have a type");
    assert!(first.reason.is_some(), "Event should have a reason");
}

#[tokio::test]
async fn integration_get_resource_events_for_deployment() {
    fresh_client();
    let ns = test_namespace();
    let events = resources::get_resource_events("deployments", "test-nginx", &ns)
        .await
        .expect("get_resource_events should succeed");

    // Deployment should have at least ScalingReplicaSet events
    assert!(
        !events.is_empty(),
        "Expected events for the test-nginx deployment"
    );
}

// ---------------------------------------------------------------------------
// Resource metadata quality
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_pod_metadata_has_all_fields() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_pods_by_selector(&ns, "app=test-nginx")
        .await
        .expect("list pods should succeed");

    let pod = &result.items[0];
    let meta = &pod.metadata;

    assert!(meta.name.is_some(), "pod should have name");
    assert!(meta.namespace.is_some(), "pod should have namespace");
    assert!(meta.uid.is_some(), "pod should have uid");
    assert!(
        meta.resource_version.is_some(),
        "pod should have resource_version"
    );
    assert!(
        meta.creation_timestamp.is_some(),
        "pod should have creation_timestamp"
    );
    assert!(meta.labels.is_some(), "pod should have labels");

    // Check that labels are correctly populated
    let labels = meta.labels.as_ref().unwrap();
    assert_eq!(
        labels.get("app").map(|s| s.as_str()),
        Some("test-nginx"),
        "pod should have app=test-nginx label"
    );
}

#[tokio::test]
async fn integration_pod_has_owner_references() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_pods_by_selector(&ns, "app=test-nginx")
        .await
        .expect("list pods should succeed");

    let pod = &result.items[0];
    assert!(
        pod.metadata.owner_references.is_some(),
        "Pod created by deployment should have owner references"
    );

    let refs = pod.metadata.owner_references.as_ref().unwrap();
    let refs_arr = refs
        .as_array()
        .expect("owner_references should be an array");
    assert!(
        !refs_arr.is_empty(),
        "Should have at least one owner reference"
    );

    let owner = &refs_arr[0];
    assert_eq!(
        owner.get("kind").and_then(|v| v.as_str()),
        Some("ReplicaSet"),
        "Pod owner should be a ReplicaSet"
    );
}

// ---------------------------------------------------------------------------
// List pods by label selector
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_list_pods_by_selector() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_pods_by_selector(&ns, "app=test-nginx")
        .await
        .expect("list_pods_by_selector should succeed");

    assert!(
        result.items.len() >= 2,
        "Expected at least 2 pods with app=test-nginx, got {}",
        result.items.len()
    );
}

#[tokio::test]
async fn integration_list_pods_by_selector_no_match() {
    fresh_client();
    let ns = test_namespace();
    let result = resources::list_pods_by_selector(&ns, "app=nonexistent-app-xyz")
        .await
        .expect("list_pods_by_selector should succeed even with no matches");

    assert!(
        result.items.is_empty(),
        "Expected no pods for non-matching selector"
    );
}
