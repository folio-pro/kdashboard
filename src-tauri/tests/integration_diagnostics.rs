//! Integration tests for the Resource Diagnostics engine.
//!
//! Tests run against a real Kind cluster with seeded resources.
//! The test-nginx deployment should be healthy; the completed test-job
//! provides an edge case.
//!
//! Run via: `./scripts/integration-test.sh`

#![cfg(feature = "integration")]

use kdashboard_lib::k8s::{client, diagnostics, resources};
use std::env;

fn test_namespace() -> String {
    env::var("KDASH_TEST_NAMESPACE").unwrap_or_else(|_| "kdash-test".into())
}

fn fresh_client() {
    client::reset_client();
}

// ---------------------------------------------------------------------------
// Pod diagnostics
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_diagnose_healthy_pod() {
    fresh_client();
    let ns = test_namespace();

    // Get a running nginx pod name
    let pods = resources::list_pods_by_selector(&ns, "app=test-nginx")
        .await
        .expect("list pods should succeed");
    let pod_name = pods.items[0]
        .metadata
        .name
        .as_deref()
        .expect("pod should have name");

    let result = diagnostics::diagnose_resource("Pod", pod_name, &ns)
        .await
        .expect("diagnose_resource should succeed");

    assert_eq!(result.resource_kind, "Pod");
    assert_eq!(result.resource_name, pod_name);
    assert!(
        result.health == "healthy" || result.health == "degraded",
        "running nginx pod should be healthy or degraded, got '{}'",
        result.health
    );
    assert!(!result.checked_at.is_empty(), "checked_at should be set");
}

#[tokio::test]
async fn integration_diagnose_deployment() {
    fresh_client();
    let ns = test_namespace();

    let result = diagnostics::diagnose_resource("Deployment", "test-nginx", &ns)
        .await
        .expect("diagnose_resource for deployment should succeed");

    assert_eq!(result.resource_kind, "Deployment");
    assert_eq!(result.resource_name, "test-nginx");
    assert!(
        ["healthy", "degraded", "unhealthy"].contains(&result.health.as_str()),
        "health should be a valid state, got '{}'",
        result.health
    );
}

#[tokio::test]
async fn integration_diagnose_unsupported_kind_falls_through() {
    fresh_client();
    let ns = test_namespace();

    // Service/ConfigMap are not explicitly supported — the module falls back
    // to Pod API, so looking up "test-nginx-svc" as a Pod will fail (expected).
    let result = diagnostics::diagnose_resource("Service", "test-nginx-svc", &ns).await;
    assert!(
        result.is_err(),
        "unsupported kinds fall through to Pod API and should fail for non-pod names"
    );
}

#[tokio::test]
async fn integration_diagnose_job() {
    fresh_client();
    let ns = test_namespace();

    let result = diagnostics::diagnose_resource("Job", "test-job", &ns)
        .await
        .expect("diagnose_resource for job should succeed");

    assert_eq!(result.resource_kind, "Job");
    assert_eq!(result.resource_name, "test-job");
    assert!(!result.checked_at.is_empty());
}

// ---------------------------------------------------------------------------
// Diagnostic issues structure
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_diagnose_result_has_valid_structure() {
    fresh_client();
    let ns = test_namespace();

    let result = diagnostics::diagnose_resource("Deployment", "test-nginx", &ns)
        .await
        .expect("diagnose should succeed");

    // Validate structure
    assert!(!result.resource_uid.is_empty(), "uid should be set");
    assert!(!result.checked_at.is_empty(), "checked_at should be set");

    // Each issue should have valid fields
    for issue in &result.issues {
        assert!(
            ["critical", "warning", "info"].contains(&issue.severity.as_str()),
            "issue severity '{}' should be valid",
            issue.severity
        );
        assert!(!issue.category.is_empty(), "issue category should be set");
        assert!(!issue.title.is_empty(), "issue title should be set");
        assert!(!issue.detail.is_empty(), "issue detail should be set");
        assert!(
            !issue.suggestion.is_empty(),
            "issue suggestion should be set"
        );
    }
}

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_diagnose_nonexistent_resource() {
    fresh_client();
    let ns = test_namespace();

    let result = diagnostics::diagnose_resource("Pod", "nonexistent-pod-xyz", &ns).await;
    assert!(
        result.is_err(),
        "diagnosing non-existent resource should return error"
    );
}

#[tokio::test]
async fn integration_diagnose_invalid_kind() {
    fresh_client();
    let ns = test_namespace();

    let result = diagnostics::diagnose_resource("FooBar", "test-nginx", &ns).await;
    assert!(
        result.is_err(),
        "diagnosing with invalid kind should return error"
    );
}
