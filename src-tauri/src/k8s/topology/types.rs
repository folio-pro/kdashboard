use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub api_version: String,
    pub status: Option<String>,
    pub is_ghost: bool,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyEdge {
    pub from: String, // parent (owner) id
    pub to: String,   // child (owned) id
    pub edge_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterGroup {
    pub controller_id: String,
    pub controller_kind: String,
    pub controller_name: String,
    pub pod_count: u32,
    pub pod_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyGraph {
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
    pub root_ids: Vec<String>,
    pub has_cycles: bool,
    pub total_resources: u32,
    pub clustered: bool,
    pub cluster_groups: Vec<ClusterGroup>,
}

#[allow(dead_code)]
impl TopologyGraph {
    /// Get immediate parent (owner) nodes for a resource by UID.
    pub fn parents_of(&self, uid: &str) -> Vec<&TopologyNode> {
        let node_map: std::collections::HashMap<&str, &TopologyNode> =
            self.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        self.edges
            .iter()
            .filter(|e| e.to == uid)
            .filter_map(|e| node_map.get(e.from.as_str()).copied())
            .collect()
    }

    /// Get immediate child (owned) nodes for a resource by UID.
    pub fn children_of(&self, uid: &str) -> Vec<&TopologyNode> {
        let node_map: std::collections::HashMap<&str, &TopologyNode> =
            self.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        self.edges
            .iter()
            .filter(|e| e.from == uid)
            .filter_map(|e| node_map.get(e.to.as_str()).copied())
            .collect()
    }

    /// Get ghost (orphaned) nodes — resources with owner refs pointing to non-existent resources.
    pub fn orphans(&self) -> Vec<&TopologyNode> {
        self.nodes.iter().filter(|n| n.is_ghost).collect()
    }
}

// ---------------------------------------------------------------------------
// Internal data types (pub(crate) for use within topology sub-modules)
// ---------------------------------------------------------------------------

pub(crate) struct RawResource {
    pub uid: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub api_version: String,
    pub status: Option<String>,
    pub owner_refs: Vec<OwnerRef>,
}

pub(crate) struct OwnerRef {
    pub uid: String,
    pub kind: String,
    pub name: String,
    pub api_version: String,
}
