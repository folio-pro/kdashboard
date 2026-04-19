//! Integration tests for Cost and Security modules.
//!
//! These modules depend on external tools (metrics-server, OpenCost, Trivy/Grype)
//! which are NOT installed in the Kind test cluster. These tests verify
//! **graceful degradation** — the modules should return valid data (or clean
//! errors) rather than panicking when the tools are absent.
//!
//! Run via: `./scripts/integration-test.sh`

#![cfg(feature = "integration")]

use kdashboard_lib::k8s::{client, cost, security};
use std::env;

fn test_namespace() -> String {
    env::var("KDASH_TEST_NAMESPACE").unwrap_or_else(|_| "kdash-test".into())
}

fn fresh_client() {
    client::reset_client();
}

// ===========================================================================
// Cost module — graceful degradation
// ===========================================================================

#[tokio::test]
async fn integration_cost_overview_without_opencost() {
    fresh_client();
    let ns = test_namespace();

    // Without OpenCost/metrics-server, this should still succeed
    // using the fallback pricing model (resource requests × default rates)
    let result = cost::get_cost_overview(Some(ns.clone())).await;

    match result {
        Ok(overview) => {
            // Should use fallback source
            assert!(
                !overview.source.is_empty(),
                "source should be set (e.g. 'fallback' or 'requests')"
            );
            assert!(!overview.fetched_at.is_empty(), "fetched_at should be set");

            // CPU and memory rates should be positive
            assert!(
                overview.cpu_rate_per_core_hour > 0.0,
                "CPU rate should be positive"
            );
            assert!(
                overview.memory_rate_per_gb_hour > 0.0,
                "memory rate should be positive"
            );

            // Test namespace has nginx pods with resource requests
            let ns_summary = overview.namespaces.iter().find(|n| n.namespace == ns);
            if let Some(summary) = ns_summary {
                assert!(
                    summary.workload_count >= 1,
                    "should have at least 1 workload (nginx deployment)"
                );
                assert!(
                    summary.total_cost_monthly >= 0.0,
                    "monthly cost should be non-negative"
                );
            }
        }
        Err(e) => {
            // If cost fails entirely, the error should be descriptive
            assert!(
                !e.to_string().is_empty(),
                "error message should be non-empty: {}",
                e
            );
        }
    }
}

#[tokio::test]
async fn integration_cost_overview_all_namespaces() {
    fresh_client();
    let result = cost::get_cost_overview(None).await;

    match result {
        Ok(overview) => {
            assert!(
                !overview.namespaces.is_empty(),
                "all-namespace cost should include at least one namespace"
            );
            assert!(
                overview.cluster_cost_monthly >= 0.0,
                "cluster cost should be non-negative"
            );
        }
        Err(_) => {
            // Acceptable — some environments lack metrics entirely
        }
    }
}

#[tokio::test]
async fn integration_node_costs_without_cloud_api() {
    fresh_client();
    let result = cost::get_node_costs().await;

    match result {
        Ok(costs) => {
            // Without cloud pricing API, may return empty or populated list
            for node_cost in &costs {
                assert!(!node_cost.node_name.is_empty(), "node name should be set");
            }
        }
        Err(_) => {
            // Acceptable degradation — cloud pricing unavailable
        }
    }
}

#[tokio::test]
async fn integration_node_metrics_without_metrics_server() {
    fresh_client();
    let result = cost::get_node_metrics().await;

    // Without metrics-server, this should fail gracefully
    // Either returns empty metrics or a clear error
    match result {
        Ok(metrics) => {
            for m in &metrics {
                assert!(!m.node_name.is_empty(), "node name should be set");
            }
        }
        Err(e) => {
            // Expected: metrics-server not installed in Kind by default
            let msg = e.to_string();
            assert!(!msg.is_empty(), "error should be descriptive");
        }
    }
}

// ===========================================================================
// Security module — graceful degradation
// ===========================================================================

#[tokio::test]
async fn integration_security_overview_without_scanner() {
    fresh_client();
    let ns = test_namespace();

    let result = security::get_security_overview(Some(ns)).await;

    match result {
        Ok(overview) => {
            // Without trivy/grype, scanner should be "none"
            // but the overview should still list pods
            assert!(!overview.scanner.is_empty(), "scanner field should be set");
            assert!(!overview.fetched_at.is_empty(), "fetched_at should be set");

            // Should enumerate pods even without scanning
            // (pods exist but vulns will be zero)
            if overview.scanner == "none" {
                assert_eq!(
                    overview.total_images_scanned, 0,
                    "no images scanned without scanner"
                );
            }
        }
        Err(e) => {
            let msg = e.to_string();
            assert!(!msg.is_empty(), "error should be descriptive");
        }
    }
}

#[tokio::test]
async fn integration_security_overview_all_namespaces() {
    fresh_client();
    let result = security::get_security_overview(None).await;

    match result {
        Ok(overview) => {
            assert!(
                overview.total_vulns.critical == 0 || overview.scanner != "none",
                "no vulns expected without a scanner"
            );
        }
        Err(_) => {
            // Acceptable
        }
    }
}

#[tokio::test]
async fn integration_scan_single_image_without_scanner() {
    fresh_client();
    let result = security::scan_single_image("nginx:1.27-alpine".to_string()).await;

    // Without trivy/grype, this should fail with a descriptive error
    // or return zero-vuln results
    match result {
        Ok(scan) => {
            assert_eq!(scan.image, "nginx:1.27-alpine");
            assert!(!scan.scanned_at.is_empty());
        }
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains("trivy")
                    || msg.contains("grype")
                    || msg.contains("scanner")
                    || msg.contains("not found")
                    || msg.contains("not installed"),
                "error should mention the missing scanner tool, got: {}",
                msg
            );
        }
    }
}

// ===========================================================================
// VulnerabilityCounts logic (unit-style, no cluster needed)
// ===========================================================================

#[test]
fn integration_vuln_counts_has_at_severity() {
    let counts = security::VulnerabilityCounts {
        critical: 0,
        high: 2,
        medium: 5,
        low: 10,
        unknown: 0,
    };

    assert!(!counts.has_at_severity("critical"), "no criticals");
    assert!(counts.has_at_severity("high"), "has highs");
    assert!(counts.has_at_severity("medium"), "has mediums (and highs)");
    assert!(counts.has_at_severity("low"), "has lows (and above)");
}

#[test]
fn integration_vuln_counts_critical_only() {
    let counts = security::VulnerabilityCounts {
        critical: 1,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
    };

    assert!(counts.has_at_severity("critical"));
    assert!(
        counts.has_at_severity("high"),
        "critical counts for high threshold"
    );
    assert!(
        counts.has_at_severity("medium"),
        "critical counts for medium threshold"
    );
}

#[test]
fn integration_vuln_counts_empty() {
    let counts = security::VulnerabilityCounts {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
    };

    assert!(!counts.has_at_severity("critical"));
    assert!(!counts.has_at_severity("high"));
    assert!(!counts.has_at_severity("medium"));
    assert!(!counts.has_at_severity("low"));
}
