mod building;
pub(crate) mod extraction;
mod queries;
pub mod types;

// Re-export public items at the topology module level so existing
// `k8s::topology::TopologyGraph` and `k8s::topology::get_namespace_topology`
// paths continue to work unchanged.
pub use queries::{get_namespace_topology, get_resource_topology};
#[allow(unused_imports)]
pub use types::{TopologyGraph, TopologyNode};

#[cfg(test)]
mod tests;
