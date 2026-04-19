//! Integration tests for the Topology graph engine.
//!
//! Tests run against a real Kind cluster with seeded resources:
//!   Deployment → ReplicaSet → Pods (2), Service, ConfigMap, Secret, Job
//!
//! Run via: `./scripts/integration-test.sh`

#![cfg(feature = "integration")]

use kdashboard_lib::k8s::{client, topology};
use std::env;

fn test_namespace() -> String {
    env::var("KDASH_TEST_NAMESPACE").unwrap_or_else(|_| "kdash-test".into())
}

fn fresh_client() {
    client::reset_client();
}

// ---------------------------------------------------------------------------
// Namespace topology
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_namespace_topology_returns_graph() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    assert!(!graph.nodes.is_empty(), "graph should have nodes");
    assert!(graph.total_resources > 0, "total_resources should be > 0");
}

#[tokio::test]
async fn integration_namespace_topology_has_expected_kinds() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    let kinds: Vec<&str> = graph.nodes.iter().map(|n| n.kind.as_str()).collect();

    assert!(kinds.contains(&"Deployment"), "should have Deployment node");
    assert!(kinds.contains(&"ReplicaSet"), "should have ReplicaSet node");
    assert!(kinds.contains(&"Pod"), "should have Pod nodes");
    assert!(kinds.contains(&"Service"), "should have Service node");
}

#[tokio::test]
async fn integration_namespace_topology_has_edges() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    assert!(
        !graph.edges.is_empty(),
        "graph should have edges (owner references)"
    );

    // Deployment → ReplicaSet edge should exist
    let deploy_node = graph
        .nodes
        .iter()
        .find(|n| n.kind == "Deployment" && n.name == "test-nginx");
    let rs_nodes: Vec<&topology::TopologyNode> = graph
        .nodes
        .iter()
        .filter(|n| n.kind == "ReplicaSet")
        .collect();

    assert!(deploy_node.is_some(), "should have test-nginx Deployment");
    assert!(!rs_nodes.is_empty(), "should have ReplicaSet nodes");

    // Check that deploy → RS edge exists
    if let Some(deploy) = deploy_node {
        let children = graph.children_of(&deploy.id);
        assert!(
            children.iter().any(|c| c.kind == "ReplicaSet"),
            "Deployment should have ReplicaSet child"
        );
    }
}

#[tokio::test]
async fn integration_namespace_topology_has_roots() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    assert!(
        !graph.root_ids.is_empty(),
        "graph should have root nodes (resources without owners)"
    );

    // Deployment and Service should be roots (no owner references)
    let root_kinds: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|n| graph.root_ids.contains(&n.id))
        .map(|n| n.kind.as_str())
        .collect();

    assert!(
        root_kinds.contains(&"Deployment"),
        "Deployment should be a root: {:?}",
        root_kinds
    );
}

#[tokio::test]
async fn integration_namespace_topology_no_cycles_in_test_data() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    assert!(
        !graph.has_cycles,
        "test data should not produce cycles in the ownership graph"
    );
}

#[tokio::test]
async fn integration_namespace_topology_parents_of() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    // Find a pod owned by the test-nginx Deployment (via its ReplicaSet)
    let pod = graph
        .nodes
        .iter()
        .find(|n| n.kind == "Pod" && n.name.starts_with("test-nginx"))
        .expect("should have at least one test-nginx Pod");

    let parents = graph.parents_of(&pod.id);
    assert!(
        !parents.is_empty(),
        "Pod should have at least one parent (ReplicaSet)"
    );
    assert_eq!(
        parents[0].kind, "ReplicaSet",
        "Pod parent should be ReplicaSet"
    );
}

#[tokio::test]
async fn integration_namespace_topology_children_of() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    let rs = graph
        .nodes
        .iter()
        .find(|n| n.kind == "ReplicaSet")
        .expect("should have a ReplicaSet");

    let children = graph.children_of(&rs.id);
    assert!(!children.is_empty(), "ReplicaSet should have Pod children");
    assert!(
        children.iter().all(|c| c.kind == "Pod"),
        "All ReplicaSet children should be Pods"
    );
}

#[tokio::test]
async fn integration_namespace_topology_orphans() {
    fresh_client();
    let ns = test_namespace();
    let graph = topology::get_namespace_topology(Some(ns))
        .await
        .expect("get_namespace_topology should succeed");

    let orphans = graph.orphans();
    // Our test data has clean ownership — no orphans expected
    // (but this test validates the method works)
    for orphan in &orphans {
        assert!(orphan.is_ghost, "orphan node should be marked as ghost");
    }
}

// ---------------------------------------------------------------------------
// Resource-scoped topology
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_resource_topology_returns_subgraph() {
    fresh_client();
    let ns = test_namespace();

    // First get the deployment's UID from namespace topology
    let full_graph = topology::get_namespace_topology(Some(ns.clone()))
        .await
        .expect("get_namespace_topology should succeed");

    let deploy = full_graph
        .nodes
        .iter()
        .find(|n| n.kind == "Deployment" && n.name == "test-nginx")
        .expect("should have test-nginx Deployment");

    let uid = deploy.id.clone();

    // Now get resource-scoped topology
    let subgraph = topology::get_resource_topology(uid, Some(ns))
        .await
        .expect("get_resource_topology should succeed");

    assert!(!subgraph.nodes.is_empty(), "subgraph should have nodes");

    // Subgraph should include the deployment, its RS, and its pods
    let kinds: Vec<&str> = subgraph.nodes.iter().map(|n| n.kind.as_str()).collect();
    assert!(
        kinds.contains(&"Deployment"),
        "subgraph should include Deployment"
    );
    assert!(
        kinds.contains(&"ReplicaSet"),
        "subgraph should include ReplicaSet"
    );
    assert!(kinds.contains(&"Pod"), "subgraph should include Pods");
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_topology_all_namespaces() {
    fresh_client();
    let graph = topology::get_namespace_topology(None)
        .await
        .expect("all-namespace topology should succeed");

    // All-namespace graph should be larger than single-namespace
    assert!(
        graph.total_resources >= 5,
        "all-namespace graph should have many resources, got {}",
        graph.total_resources
    );
}

#[tokio::test]
async fn integration_resource_topology_nonexistent_uid() {
    fresh_client();
    let ns = test_namespace();
    let result = topology::get_resource_topology("nonexistent-uid-xyz".into(), Some(ns)).await;

    // Should succeed but return empty or minimal graph
    assert!(result.is_ok(), "nonexistent UID should not error");
    // The graph might still contain namespace resources,
    // but shouldn't crash
}
