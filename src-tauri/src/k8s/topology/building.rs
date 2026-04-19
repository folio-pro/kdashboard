use std::collections::{HashMap, HashSet, VecDeque};

use super::types::{ClusterGroup, RawResource, TopologyEdge, TopologyGraph, TopologyNode};

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

pub(crate) fn build_graph(resources: Vec<RawResource>, auto_cluster: bool) -> TopologyGraph {
    let total_resources = resources.len() as u32;
    let mut nodes_map: HashMap<String, TopologyNode> = HashMap::new();
    let mut edges: Vec<TopologyEdge> = Vec::new();
    let mut children_of: HashMap<String, Vec<String>> = HashMap::new(); // parent → children
    let mut has_parent: HashSet<String> = HashSet::new();

    // Index all resources by UID
    for r in &resources {
        nodes_map.insert(
            r.uid.clone(),
            TopologyNode {
                id: r.uid.clone(),
                kind: r.kind.clone(),
                name: r.name.clone(),
                namespace: r.namespace.clone(),
                api_version: r.api_version.clone(),
                status: r.status.clone(),
                is_ghost: false,
                depth: 0,
            },
        );
    }

    // Build edges from owner references
    for r in &resources {
        for oref in &r.owner_refs {
            let owner_id = oref.uid.clone();

            // Create ghost node if owner not found
            if !nodes_map.contains_key(&owner_id) {
                nodes_map.insert(
                    owner_id.clone(),
                    TopologyNode {
                        id: owner_id.clone(),
                        kind: oref.kind.clone(),
                        name: oref.name.clone(),
                        namespace: r.namespace.clone(),
                        api_version: oref.api_version.clone(),
                        status: None,
                        is_ghost: true,
                        depth: 0,
                    },
                );
            }

            edges.push(TopologyEdge {
                from: owner_id.clone(),
                to: r.uid.clone(),
                edge_type: "owner".to_string(),
            });

            children_of.entry(owner_id).or_default().push(r.uid.clone());
            has_parent.insert(r.uid.clone());
        }
    }

    // Cycle detection via DFS
    let has_cycles = detect_and_break_cycles(&nodes_map, &mut edges);

    // Find roots (no incoming edges after cycle removal)
    let nodes_with_parents: HashSet<&str> = edges.iter().map(|e| e.to.as_str()).collect();
    let root_ids: Vec<String> = nodes_map
        .keys()
        .filter(|id| !nodes_with_parents.contains(id.as_str()))
        .cloned()
        .collect();

    // BFS to assign depth
    assign_depths(&root_ids, &edges, &mut nodes_map);

    // Auto-clustering: group pods by controller when >200 nodes
    let (clustered, cluster_groups) = if auto_cluster {
        extract_pod_clusters(&mut nodes_map, &mut edges)
    } else {
        (false, Vec::new())
    };

    let nodes: Vec<TopologyNode> = nodes_map.into_values().collect();

    TopologyGraph {
        nodes,
        edges,
        root_ids,
        has_cycles,
        total_resources,
        clustered,
        cluster_groups,
    }
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

fn detect_and_break_cycles(
    nodes_map: &HashMap<String, TopologyNode>,
    edges: &mut Vec<TopologyEdge>,
) -> bool {
    let adj: HashMap<&str, Vec<&str>> = {
        let mut m: HashMap<&str, Vec<&str>> = HashMap::new();
        for e in edges.iter() {
            m.entry(e.from.as_str()).or_default().push(e.to.as_str());
        }
        m
    };

    let mut visited: HashSet<&str> = HashSet::new();
    let mut in_stack: HashSet<&str> = HashSet::new();
    let mut back_edges: Vec<(String, String)> = Vec::new();

    fn dfs<'a>(
        node: &'a str,
        adj: &HashMap<&'a str, Vec<&'a str>>,
        visited: &mut HashSet<&'a str>,
        in_stack: &mut HashSet<&'a str>,
        back_edges: &mut Vec<(String, String)>,
    ) {
        visited.insert(node);
        in_stack.insert(node);

        if let Some(children) = adj.get(node) {
            for &child in children {
                if in_stack.contains(child) {
                    back_edges.push((node.to_string(), child.to_string()));
                } else if !visited.contains(child) {
                    dfs(child, adj, visited, in_stack, back_edges);
                }
            }
        }

        in_stack.remove(node);
    }

    for id in nodes_map.keys() {
        if !visited.contains(id.as_str()) {
            dfs(
                id.as_str(),
                &adj,
                &mut visited,
                &mut in_stack,
                &mut back_edges,
            );
        }
    }

    if !back_edges.is_empty() {
        let back_set: HashSet<(&str, &str)> = back_edges
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        edges.retain(|e| !back_set.contains(&(e.from.as_str(), e.to.as_str())));
        true
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// BFS depth assignment
// ---------------------------------------------------------------------------

fn assign_depths(
    root_ids: &[String],
    edges: &[TopologyEdge],
    nodes_map: &mut HashMap<String, TopologyNode>,
) {
    let adj: HashMap<&str, Vec<&str>> = {
        let mut m: HashMap<&str, Vec<&str>> = HashMap::new();
        for e in edges {
            m.entry(e.from.as_str()).or_default().push(e.to.as_str());
        }
        m
    };

    let mut queue: VecDeque<&str> = VecDeque::new();
    let mut visited: HashSet<&str> = HashSet::new();

    for root in root_ids {
        queue.push_back(root.as_str());
        visited.insert(root.as_str());
        if let Some(node) = nodes_map.get_mut(root) {
            node.depth = 0;
        }
    }

    while let Some(current) = queue.pop_front() {
        let current_depth = nodes_map.get(current).map(|n| n.depth).unwrap_or(0);
        if let Some(children) = adj.get(current) {
            for &child in children {
                if !visited.contains(child) {
                    visited.insert(child);
                    if let Some(node) = nodes_map.get_mut(child) {
                        node.depth = current_depth + 1;
                    }
                    queue.push_back(child);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pod clustering
// ---------------------------------------------------------------------------

/// Groups pods by their controller when node count exceeds 200.
/// Returns `(clustered, cluster_groups)` and mutates `nodes_map`/`edges` in place
/// by removing the clustered pod nodes and their edges.
fn extract_pod_clusters(
    nodes_map: &mut HashMap<String, TopologyNode>,
    edges: &mut Vec<TopologyEdge>,
) -> (bool, Vec<ClusterGroup>) {
    if nodes_map.len() <= 200 {
        return (false, Vec::new());
    }

    let mut cluster_groups: Vec<ClusterGroup> = Vec::new();

    // Group pods by their owner (controller)
    let mut controller_pods: HashMap<String, Vec<String>> = HashMap::new();
    for e in edges.iter() {
        if let Some(child_node) = nodes_map.get(&e.to) {
            if child_node.kind == "Pod" {
                controller_pods
                    .entry(e.from.clone())
                    .or_default()
                    .push(e.to.clone());
            }
        }
    }

    // Create cluster groups for controllers with >3 pods
    let mut remove_ids: HashSet<String> = HashSet::new();
    for (controller_id, pod_ids) in &controller_pods {
        if pod_ids.len() > 3 {
            let controller = nodes_map.get(controller_id);
            cluster_groups.push(ClusterGroup {
                controller_id: controller_id.clone(),
                controller_kind: controller.map(|c| c.kind.clone()).unwrap_or_default(),
                controller_name: controller.map(|c| c.name.clone()).unwrap_or_default(),
                pod_count: pod_ids.len() as u32,
                pod_ids: pod_ids.clone(),
            });
            for pid in pod_ids {
                remove_ids.insert(pid.clone());
            }
        }
    }

    // Remove clustered pods from nodes and edges
    for id in &remove_ids {
        nodes_map.remove(id);
    }
    edges.retain(|e| !remove_ids.contains(&e.to));

    (true, cluster_groups)
}
