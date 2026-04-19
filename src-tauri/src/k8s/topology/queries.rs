use std::collections::{HashMap, HashSet, VecDeque};

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;

use super::building::build_graph;
use super::extraction::fetch_typed;
use super::types::{RawResource, TopologyEdge, TopologyGraph, TopologyNode};
use crate::k8s::client::get_client;

// ---------------------------------------------------------------------------
// Public API — Tauri commands call these
// ---------------------------------------------------------------------------

pub async fn get_namespace_topology(namespace: Option<String>) -> anyhow::Result<TopologyGraph> {
    let client = get_client().await?;

    // Fetch all workload types in parallel
    let (
        pods,
        deployments,
        replicasets,
        statefulsets,
        daemonsets,
        jobs,
        cronjobs,
        services,
        ingresses,
        configmaps,
        secrets,
        hpas,
    ) = tokio::join!(
        async { fetch_typed!(client, namespace, Pod, "Pod", "v1") },
        async { fetch_typed!(client, namespace, Deployment, "Deployment", "apps/v1") },
        async { fetch_typed!(client, namespace, ReplicaSet, "ReplicaSet", "apps/v1") },
        async { fetch_typed!(client, namespace, StatefulSet, "StatefulSet", "apps/v1") },
        async { fetch_typed!(client, namespace, DaemonSet, "DaemonSet", "apps/v1") },
        async { fetch_typed!(client, namespace, Job, "Job", "batch/v1") },
        async { fetch_typed!(client, namespace, CronJob, "CronJob", "batch/v1") },
        async { fetch_typed!(client, namespace, Service, "Service", "v1") },
        async {
            fetch_typed!(
                client,
                namespace,
                Ingress,
                "Ingress",
                "networking.k8s.io/v1"
            )
        },
        async { fetch_typed!(client, namespace, ConfigMap, "ConfigMap", "v1") },
        async { fetch_typed!(client, namespace, Secret, "Secret", "v1") },
        async {
            fetch_typed!(
                client,
                namespace,
                HorizontalPodAutoscaler,
                "HorizontalPodAutoscaler",
                "autoscaling/v2"
            )
        },
    );

    let mut all: Vec<RawResource> = Vec::new();
    all.extend(pods);
    all.extend(deployments);
    all.extend(replicasets);
    all.extend(statefulsets);
    all.extend(daemonsets);
    all.extend(jobs);
    all.extend(cronjobs);
    all.extend(services);
    all.extend(ingresses);
    all.extend(configmaps);
    all.extend(secrets);
    all.extend(hpas);

    Ok(build_graph(all, true))
}

pub async fn get_resource_topology(
    uid: String,
    namespace: Option<String>,
) -> anyhow::Result<TopologyGraph> {
    // Fetch full namespace topology, then extract subgraph for the given UID
    let full = get_namespace_topology(namespace).await?;

    // Build adjacency using owned Strings
    let mut children_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut parents_of: HashMap<String, Vec<String>> = HashMap::new();
    for e in &full.edges {
        children_of
            .entry(e.from.clone())
            .or_default()
            .push(e.to.clone());
        parents_of
            .entry(e.to.clone())
            .or_default()
            .push(e.from.clone());
    }

    // BFS in both directions to find connected subgraph
    let mut included: HashSet<String> = HashSet::new();

    if full.nodes.iter().any(|n| n.id == uid) {
        included.insert(uid.clone());

        // Walk up to ancestors
        let mut up_queue: VecDeque<String> = VecDeque::new();
        up_queue.push_back(uid.clone());
        while let Some(current) = up_queue.pop_front() {
            if let Some(parents) = parents_of.get(&current) {
                for p in parents {
                    if included.insert(p.clone()) {
                        up_queue.push_back(p.clone());
                    }
                }
            }
        }

        // Walk down to descendants
        let mut queue: VecDeque<String> = VecDeque::new();
        queue.push_back(uid.clone());
        while let Some(current) = queue.pop_front() {
            if let Some(children) = children_of.get(&current) {
                for c in children {
                    if included.insert(c.clone()) {
                        queue.push_back(c.clone());
                    }
                }
            }
        }
    }

    let nodes: Vec<TopologyNode> = full
        .nodes
        .into_iter()
        .filter(|n| included.contains(&n.id))
        .collect();
    let edges: Vec<TopologyEdge> = full
        .edges
        .into_iter()
        .filter(|e| included.contains(&e.from) && included.contains(&e.to))
        .collect();
    let root_ids: Vec<String> = full
        .root_ids
        .into_iter()
        .filter(|id| included.contains(id.as_str()))
        .collect();

    Ok(TopologyGraph {
        nodes,
        edges,
        root_ids,
        has_cycles: full.has_cycles,
        total_resources: included.len() as u32,
        clustered: false,
        cluster_groups: vec![],
    })
}
