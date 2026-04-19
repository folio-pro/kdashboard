use std::collections::HashMap;

use super::building::build_graph;
use super::extraction::{extract_status_str, parse_owner_refs};
use super::types::{OwnerRef, RawResource, TopologyNode};

// -----------------------------------------------------------------------
// Helpers to build test resources
// -----------------------------------------------------------------------

fn make_raw(uid: &str, kind: &str, name: &str, owner_refs: Vec<OwnerRef>) -> RawResource {
    RawResource {
        uid: uid.into(),
        kind: kind.into(),
        name: name.into(),
        namespace: Some("default".into()),
        api_version: "v1".into(),
        status: Some("Running".into()),
        owner_refs,
    }
}

fn make_owner_ref(uid: &str, kind: &str, name: &str) -> OwnerRef {
    OwnerRef {
        uid: uid.into(),
        kind: kind.into(),
        name: name.into(),
        api_version: "apps/v1".into(),
    }
}

// -----------------------------------------------------------------------
// build_graph: empty input
// -----------------------------------------------------------------------

#[test]
fn empty_resources_produce_empty_graph() {
    let graph = build_graph(vec![], false);
    assert!(graph.nodes.is_empty());
    assert!(graph.edges.is_empty());
    assert!(graph.root_ids.is_empty());
    assert!(!graph.has_cycles);
    assert_eq!(graph.total_resources, 0);
    assert!(!graph.clustered);
}

// -----------------------------------------------------------------------
// build_graph: single root resource (no owner refs)
// -----------------------------------------------------------------------

#[test]
fn single_root_node_is_root() {
    let resources = vec![make_raw("uid-1", "Deployment", "my-deploy", vec![])];
    let graph = build_graph(resources, false);

    assert_eq!(graph.nodes.len(), 1);
    assert_eq!(graph.edges.len(), 0);
    assert_eq!(graph.root_ids.len(), 1);
    assert_eq!(graph.root_ids[0], "uid-1");
    assert_eq!(graph.nodes[0].depth, 0);
    assert!(!graph.nodes[0].is_ghost);
}

// -----------------------------------------------------------------------
// build_graph: parent-child relationship via owner refs
// -----------------------------------------------------------------------

#[test]
fn owner_ref_creates_edge_and_depth() {
    let resources = vec![
        make_raw("uid-deploy", "Deployment", "my-deploy", vec![]),
        make_raw(
            "uid-rs",
            "ReplicaSet",
            "my-rs",
            vec![make_owner_ref("uid-deploy", "Deployment", "my-deploy")],
        ),
        make_raw(
            "uid-pod",
            "Pod",
            "my-pod",
            vec![make_owner_ref("uid-rs", "ReplicaSet", "my-rs")],
        ),
    ];
    let graph = build_graph(resources, false);

    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.edges.len(), 2);
    assert_eq!(graph.total_resources, 3);

    // Only the deployment should be a root
    assert_eq!(graph.root_ids.len(), 1);
    assert!(graph.root_ids.contains(&"uid-deploy".to_string()));

    // Check depths
    let node_map: HashMap<&str, &TopologyNode> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    assert_eq!(node_map["uid-deploy"].depth, 0);
    assert_eq!(node_map["uid-rs"].depth, 1);
    assert_eq!(node_map["uid-pod"].depth, 2);
}

// -----------------------------------------------------------------------
// build_graph: ghost nodes for missing owners
// -----------------------------------------------------------------------

#[test]
fn missing_owner_creates_ghost_node() {
    let resources = vec![make_raw(
        "uid-pod",
        "Pod",
        "orphan-pod",
        vec![make_owner_ref("uid-missing", "ReplicaSet", "deleted-rs")],
    )];
    let graph = build_graph(resources, false);

    // Should have 2 nodes: the pod + the ghost
    assert_eq!(graph.nodes.len(), 2);
    let ghost = graph.nodes.iter().find(|n| n.id == "uid-missing").unwrap();
    assert!(ghost.is_ghost);
    assert_eq!(ghost.kind, "ReplicaSet");
    assert_eq!(ghost.name, "deleted-rs");
}

// -----------------------------------------------------------------------
// build_graph: cycle detection
// -----------------------------------------------------------------------

#[test]
fn cycle_is_detected_and_broken() {
    // A -> B -> A (cycle via owner refs)
    let resources = vec![
        RawResource {
            uid: "a".into(),
            kind: "Deployment".into(),
            name: "a".into(),
            namespace: Some("default".into()),
            api_version: "v1".into(),
            status: None,
            owner_refs: vec![OwnerRef {
                uid: "b".into(),
                kind: "ReplicaSet".into(),
                name: "b".into(),
                api_version: "v1".into(),
            }],
        },
        RawResource {
            uid: "b".into(),
            kind: "ReplicaSet".into(),
            name: "b".into(),
            namespace: Some("default".into()),
            api_version: "v1".into(),
            status: None,
            owner_refs: vec![OwnerRef {
                uid: "a".into(),
                kind: "Deployment".into(),
                name: "a".into(),
                api_version: "v1".into(),
            }],
        },
    ];
    let graph = build_graph(resources, false);
    assert!(graph.has_cycles);
    // After breaking the cycle, at least one back edge removed
    // so edges < 2 (was 2 before cycle removal)
    assert!(graph.edges.len() < 2);
}

// -----------------------------------------------------------------------
// build_graph: auto-clustering kicks in above 200 nodes
// -----------------------------------------------------------------------

#[test]
fn auto_cluster_groups_pods_above_threshold() {
    // Create 1 controller + 210 pods owned by it (total 211 > 200)
    let mut resources = vec![make_raw("ctrl-1", "ReplicaSet", "rs-1", vec![])];
    for i in 0..210 {
        resources.push(make_raw(
            &format!("pod-{}", i),
            "Pod",
            &format!("pod-{}", i),
            vec![make_owner_ref("ctrl-1", "ReplicaSet", "rs-1")],
        ));
    }
    let graph = build_graph(resources, true);

    assert!(graph.clustered);
    assert_eq!(graph.cluster_groups.len(), 1);
    assert_eq!(graph.cluster_groups[0].controller_id, "ctrl-1");
    assert_eq!(graph.cluster_groups[0].pod_count, 210);
    // Clustered pods should be removed from nodes
    assert!(graph.nodes.len() < 20); // only controller + any leftovers
}

#[test]
fn auto_cluster_disabled_keeps_all_nodes() {
    let mut resources = vec![make_raw("ctrl-1", "ReplicaSet", "rs-1", vec![])];
    for i in 0..210 {
        resources.push(make_raw(
            &format!("pod-{}", i),
            "Pod",
            &format!("pod-{}", i),
            vec![make_owner_ref("ctrl-1", "ReplicaSet", "rs-1")],
        ));
    }
    let graph = build_graph(resources, false);

    assert!(!graph.clustered);
    assert!(graph.cluster_groups.is_empty());
    assert_eq!(graph.nodes.len(), 211);
}

#[test]
fn auto_cluster_skips_small_pod_groups() {
    // 201 total nodes but the controller only has 2 pods (< 3 threshold)
    let mut resources = Vec::new();
    // Create many standalone nodes to exceed 200
    for i in 0..199 {
        resources.push(make_raw(
            &format!("standalone-{}", i),
            "ConfigMap",
            &format!("cm-{}", i),
            vec![],
        ));
    }
    // Controller with only 2 pods
    resources.push(make_raw("ctrl-1", "ReplicaSet", "rs-1", vec![]));
    resources.push(make_raw(
        "pod-a",
        "Pod",
        "pod-a",
        vec![make_owner_ref("ctrl-1", "ReplicaSet", "rs-1")],
    ));
    resources.push(make_raw(
        "pod-b",
        "Pod",
        "pod-b",
        vec![make_owner_ref("ctrl-1", "ReplicaSet", "rs-1")],
    ));

    let graph = build_graph(resources, true);
    assert!(graph.clustered);
    // No cluster groups because the controller only has 2 pods (threshold is > 3)
    assert!(graph.cluster_groups.is_empty());
}

// -----------------------------------------------------------------------
// TopologyGraph::parents_of / children_of
// -----------------------------------------------------------------------

#[test]
fn parents_of_returns_owner_nodes() {
    let resources = vec![
        make_raw("uid-deploy", "Deployment", "deploy", vec![]),
        make_raw(
            "uid-rs",
            "ReplicaSet",
            "rs",
            vec![make_owner_ref("uid-deploy", "Deployment", "deploy")],
        ),
    ];
    let graph = build_graph(resources, false);

    let parents = graph.parents_of("uid-rs");
    assert_eq!(parents.len(), 1);
    assert_eq!(parents[0].id, "uid-deploy");
}

#[test]
fn children_of_returns_owned_nodes() {
    let resources = vec![
        make_raw("uid-deploy", "Deployment", "deploy", vec![]),
        make_raw(
            "uid-rs",
            "ReplicaSet",
            "rs",
            vec![make_owner_ref("uid-deploy", "Deployment", "deploy")],
        ),
    ];
    let graph = build_graph(resources, false);

    let children = graph.children_of("uid-deploy");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].id, "uid-rs");
}

#[test]
fn parents_of_root_is_empty() {
    let resources = vec![make_raw("uid-1", "Deployment", "deploy", vec![])];
    let graph = build_graph(resources, false);
    assert!(graph.parents_of("uid-1").is_empty());
}

// -----------------------------------------------------------------------
// TopologyGraph::orphans
// -----------------------------------------------------------------------

#[test]
fn orphans_returns_ghost_nodes() {
    let resources = vec![make_raw(
        "uid-pod",
        "Pod",
        "pod",
        vec![make_owner_ref("uid-ghost", "ReplicaSet", "gone-rs")],
    )];
    let graph = build_graph(resources, false);

    let orphans = graph.orphans();
    assert_eq!(orphans.len(), 1);
    assert_eq!(orphans[0].id, "uid-ghost");
    assert!(orphans[0].is_ghost);
}

#[test]
fn no_orphans_when_all_owners_exist() {
    let resources = vec![
        make_raw("uid-rs", "ReplicaSet", "rs", vec![]),
        make_raw(
            "uid-pod",
            "Pod",
            "pod",
            vec![make_owner_ref("uid-rs", "ReplicaSet", "rs")],
        ),
    ];
    let graph = build_graph(resources, false);
    assert!(graph.orphans().is_empty());
}

// -----------------------------------------------------------------------
// extract_status_str
// -----------------------------------------------------------------------

#[test]
fn extract_status_pod_phase() {
    let obj = serde_json::json!({"status": {"phase": "Running"}});
    assert_eq!(extract_status_str("Pod", &obj), Some("Running".into()));
}

#[test]
fn extract_status_deployment_available() {
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Available", "status": "True"}
            ]
        }
    });
    assert_eq!(
        extract_status_str("Deployment", &obj),
        Some("Available".into())
    );
}

#[test]
fn extract_status_deployment_unavailable() {
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Available", "status": "False"}
            ]
        }
    });
    assert_eq!(
        extract_status_str("Deployment", &obj),
        Some("Unavailable".into())
    );
}

#[test]
fn extract_status_job_complete() {
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Complete", "status": "True"}
            ]
        }
    });
    assert_eq!(extract_status_str("Job", &obj), Some("Complete".into()));
}

#[test]
fn extract_status_job_failed() {
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Failed", "status": "True"}
            ]
        }
    });
    assert_eq!(extract_status_str("Job", &obj), Some("Failed".into()));
}

#[test]
fn extract_status_job_running_no_conditions() {
    let obj = serde_json::json!({"status": {}});
    assert_eq!(extract_status_str("Job", &obj), Some("Running".into()));
}

#[test]
fn extract_status_service_type() {
    let obj = serde_json::json!({"status": {}, "spec": {"type": "ClusterIP"}});
    assert_eq!(
        extract_status_str("Service", &obj),
        Some("ClusterIP".into())
    );
}

#[test]
fn extract_status_unknown_kind_returns_none() {
    let obj = serde_json::json!({"status": {"phase": "Running"}});
    assert_eq!(extract_status_str("ConfigMap", &obj), None);
}

#[test]
fn extract_status_no_status_field_returns_none() {
    let obj = serde_json::json!({"metadata": {"name": "test"}});
    assert_eq!(extract_status_str("Pod", &obj), None);
}

#[test]
fn extract_status_pod_pending() {
    let obj = serde_json::json!({"status": {"phase": "Pending"}});
    assert_eq!(extract_status_str("Pod", &obj), Some("Pending".into()));
}

#[test]
fn extract_status_pod_failed() {
    let obj = serde_json::json!({"status": {"phase": "Failed"}});
    assert_eq!(extract_status_str("Pod", &obj), Some("Failed".into()));
}

#[test]
fn extract_status_pod_succeeded() {
    let obj = serde_json::json!({"status": {"phase": "Succeeded"}});
    assert_eq!(extract_status_str("Pod", &obj), Some("Succeeded".into()));
}

#[test]
fn extract_status_pod_no_phase_returns_none() {
    let obj = serde_json::json!({"status": {}});
    assert_eq!(extract_status_str("Pod", &obj), None);
}

#[test]
fn extract_status_statefulset_available() {
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Available", "status": "True"}
            ]
        }
    });
    assert_eq!(
        extract_status_str("StatefulSet", &obj),
        Some("Available".into())
    );
}

#[test]
fn extract_status_daemonset_unavailable() {
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Available", "status": "False"}
            ]
        }
    });
    assert_eq!(
        extract_status_str("DaemonSet", &obj),
        Some("Unavailable".into())
    );
}

#[test]
fn extract_status_deployment_no_available_condition_returns_unknown() {
    // Only Progressing condition, no Available — falls through to Unknown
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Progressing", "status": "True"}
            ]
        }
    });
    assert_eq!(
        extract_status_str("Deployment", &obj),
        Some("Unknown".into())
    );
}

#[test]
fn extract_status_deployment_empty_conditions_returns_unknown() {
    let obj = serde_json::json!({
        "status": {
            "conditions": []
        }
    });
    assert_eq!(
        extract_status_str("Deployment", &obj),
        Some("Unknown".into())
    );
}

#[test]
fn extract_status_deployment_no_conditions_key_returns_unknown() {
    let obj = serde_json::json!({"status": {}});
    assert_eq!(
        extract_status_str("Deployment", &obj),
        Some("Unknown".into())
    );
}

#[test]
fn extract_status_service_loadbalancer() {
    let obj = serde_json::json!({"status": {}, "spec": {"type": "LoadBalancer"}});
    assert_eq!(
        extract_status_str("Service", &obj),
        Some("LoadBalancer".into())
    );
}

#[test]
fn extract_status_service_nodeport() {
    let obj = serde_json::json!({"status": {}, "spec": {"type": "NodePort"}});
    assert_eq!(extract_status_str("Service", &obj), Some("NodePort".into()));
}

#[test]
fn extract_status_service_no_spec_returns_none() {
    let obj = serde_json::json!({"status": {}});
    assert_eq!(extract_status_str("Service", &obj), None);
}

#[test]
fn extract_status_job_running_when_no_matching_condition() {
    // Conditions exist but none are Complete or Failed with True
    let obj = serde_json::json!({
        "status": {
            "conditions": [
                {"type": "Complete", "status": "False"}
            ]
        }
    });
    assert_eq!(extract_status_str("Job", &obj), Some("Running".into()));
}

// -----------------------------------------------------------------------
// parse_owner_refs
// -----------------------------------------------------------------------

#[test]
fn parse_owner_refs_extracts_all_fields() {
    let meta = serde_json::json!({
        "ownerReferences": [
            {
                "uid": "abc-123",
                "kind": "ReplicaSet",
                "name": "my-rs",
                "apiVersion": "apps/v1"
            }
        ]
    });
    let refs = parse_owner_refs(&meta);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].uid, "abc-123");
    assert_eq!(refs[0].kind, "ReplicaSet");
    assert_eq!(refs[0].name, "my-rs");
    assert_eq!(refs[0].api_version, "apps/v1");
}

#[test]
fn parse_owner_refs_empty_when_missing() {
    let meta = serde_json::json!({"name": "test"});
    assert!(parse_owner_refs(&meta).is_empty());
}

#[test]
fn parse_owner_refs_skips_malformed_entries() {
    let meta = serde_json::json!({
        "ownerReferences": [
            {"uid": "abc", "kind": "RS"},  // missing name
            {"uid": "def", "kind": "RS", "name": "ok"}
        ]
    });
    let refs = parse_owner_refs(&meta);
    // First entry missing "name" is filtered out
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].uid, "def");
}

#[test]
fn parse_owner_refs_multiple_valid_entries() {
    let meta = serde_json::json!({
        "ownerReferences": [
            {"uid": "uid-1", "kind": "ReplicaSet", "name": "rs-1", "apiVersion": "apps/v1"},
            {"uid": "uid-2", "kind": "Deployment", "name": "deploy-1", "apiVersion": "apps/v1"}
        ]
    });
    let refs = parse_owner_refs(&meta);
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].uid, "uid-1");
    assert_eq!(refs[1].uid, "uid-2");
}

#[test]
fn parse_owner_refs_missing_api_version_defaults_to_empty() {
    let meta = serde_json::json!({
        "ownerReferences": [
            {"uid": "uid-1", "kind": "ReplicaSet", "name": "rs-1"}
        ]
    });
    let refs = parse_owner_refs(&meta);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].api_version, "");
}

#[test]
fn parse_owner_refs_empty_array() {
    let meta = serde_json::json!({"ownerReferences": []});
    assert!(parse_owner_refs(&meta).is_empty());
}

#[test]
fn parse_owner_refs_null_value() {
    let meta = serde_json::json!({"ownerReferences": null});
    assert!(parse_owner_refs(&meta).is_empty());
}

// -----------------------------------------------------------------------
// build_graph: multiple roots
// -----------------------------------------------------------------------

#[test]
fn multiple_roots_when_no_owner_refs() {
    let resources = vec![
        make_raw("uid-1", "Deployment", "deploy-1", vec![]),
        make_raw("uid-2", "Service", "svc-1", vec![]),
        make_raw("uid-3", "ConfigMap", "cm-1", vec![]),
    ];
    let graph = build_graph(resources, false);

    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.edges.len(), 0);
    assert_eq!(graph.root_ids.len(), 3);
    // All nodes at depth 0
    for node in &graph.nodes {
        assert_eq!(node.depth, 0);
    }
}

// -----------------------------------------------------------------------
// build_graph: deep hierarchy (4 levels)
// -----------------------------------------------------------------------

#[test]
fn deep_hierarchy_assigns_correct_depths() {
    let resources = vec![
        make_raw("uid-a", "Deployment", "deploy", vec![]),
        make_raw(
            "uid-b",
            "ReplicaSet",
            "rs",
            vec![make_owner_ref("uid-a", "Deployment", "deploy")],
        ),
        make_raw(
            "uid-c",
            "Pod",
            "pod",
            vec![make_owner_ref("uid-b", "ReplicaSet", "rs")],
        ),
        make_raw(
            "uid-d",
            "Container",
            "sidecar",
            vec![make_owner_ref("uid-c", "Pod", "pod")],
        ),
    ];
    let graph = build_graph(resources, false);

    let node_map: HashMap<&str, &TopologyNode> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    assert_eq!(node_map["uid-a"].depth, 0);
    assert_eq!(node_map["uid-b"].depth, 1);
    assert_eq!(node_map["uid-c"].depth, 2);
    assert_eq!(node_map["uid-d"].depth, 3);
    assert_eq!(graph.root_ids, vec!["uid-a"]);
}

// -----------------------------------------------------------------------
// build_graph: fan-out (one parent, multiple children)
// -----------------------------------------------------------------------

#[test]
fn fan_out_single_parent_multiple_children() {
    let resources = vec![
        make_raw("uid-rs", "ReplicaSet", "rs", vec![]),
        make_raw(
            "uid-p1",
            "Pod",
            "pod-1",
            vec![make_owner_ref("uid-rs", "ReplicaSet", "rs")],
        ),
        make_raw(
            "uid-p2",
            "Pod",
            "pod-2",
            vec![make_owner_ref("uid-rs", "ReplicaSet", "rs")],
        ),
        make_raw(
            "uid-p3",
            "Pod",
            "pod-3",
            vec![make_owner_ref("uid-rs", "ReplicaSet", "rs")],
        ),
    ];
    let graph = build_graph(resources, false);

    assert_eq!(graph.nodes.len(), 4);
    assert_eq!(graph.edges.len(), 3);
    assert_eq!(graph.root_ids.len(), 1);
    assert_eq!(graph.root_ids[0], "uid-rs");

    let children = graph.children_of("uid-rs");
    assert_eq!(children.len(), 3);
    // All pods at depth 1
    for child in &children {
        assert_eq!(child.depth, 1);
        assert_eq!(child.kind, "Pod");
    }
}

// -----------------------------------------------------------------------
// build_graph: edge_type is always "owner"
// -----------------------------------------------------------------------

#[test]
fn all_edges_have_owner_type() {
    let resources = vec![
        make_raw("uid-deploy", "Deployment", "deploy", vec![]),
        make_raw(
            "uid-rs",
            "ReplicaSet",
            "rs",
            vec![make_owner_ref("uid-deploy", "Deployment", "deploy")],
        ),
    ];
    let graph = build_graph(resources, false);
    for edge in &graph.edges {
        assert_eq!(edge.edge_type, "owner");
    }
}

// -----------------------------------------------------------------------
// build_graph: ghost node inherits namespace from child
// -----------------------------------------------------------------------

#[test]
fn ghost_node_inherits_child_namespace() {
    let mut pod = make_raw(
        "uid-pod",
        "Pod",
        "my-pod",
        vec![make_owner_ref("uid-ghost", "ReplicaSet", "phantom-rs")],
    );
    pod.namespace = Some("production".into());
    let graph = build_graph(vec![pod], false);

    let ghost = graph.nodes.iter().find(|n| n.id == "uid-ghost").unwrap();
    assert_eq!(ghost.namespace, Some("production".into()));
}
