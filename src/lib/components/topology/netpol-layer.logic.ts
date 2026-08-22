// Pure mapping from the NetworkPolicy overview onto topology node ids.

import type { AllowedFlow, NetworkPolicyOverview, TopologyGraph, WorkloadPolicyStatus } from "$lib/types";

export type IsolationBadge = "isolated" | "partial" | "open";

export interface NetpolOverlay {
  /** Topology node id → isolation badge. Pods inherit their owner's status. */
  badges: Map<string, IsolationBadge>;
  /** Allowed ingress flows as node-id pairs (only those whose ends are on the graph). */
  flows: Array<{ from: string; to: string; ports: string[]; policy: string }>;
  /** Node id → workload status, for the side panel. */
  status: Map<string, WorkloadPolicyStatus>;
}

export function badgeFor(w: WorkloadPolicyStatus): IsolationBadge {
  if (w.isolated_ingress && w.isolated_egress) return "isolated";
  if (w.isolated_ingress || w.isolated_egress) return "partial";
  return "open";
}

/** Deployment pods are owned by ReplicaSets named `<deploy>-<hash>`; strip the hash. */
function workloadKeyOfNode(node: TopologyGraph["nodes"][number], graph: TopologyGraph): string | null {
  if (node.kind === "Pod") {
    // Walk the owner edge (ReplicaSet/StatefulSet/DaemonSet → Pod) to the workload.
    const owner = graph.edges.find((e) => e.to === node.id && e.edge_type === "owns");
    const parent = owner ? graph.nodes.find((n) => n.id === owner.from) : undefined;
    if (!parent) return `Pod/${node.name}`;
    if (parent.kind === "ReplicaSet") {
      const grand = graph.edges.find((e) => e.to === parent.id && e.edge_type === "owns");
      const gp = grand ? graph.nodes.find((n) => n.id === grand.from) : undefined;
      if (gp) return `${gp.kind}/${gp.name}`;
      const idx = parent.name.lastIndexOf("-");
      return `Deployment/${idx > 0 ? parent.name.slice(0, idx) : parent.name}`;
    }
    return `${parent.kind}/${parent.name}`;
  }
  if (node.kind === "ReplicaSet") {
    const idx = node.name.lastIndexOf("-");
    return `Deployment/${idx > 0 ? node.name.slice(0, idx) : node.name}`;
  }
  if (node.kind === "Deployment" || node.kind === "StatefulSet" || node.kind === "DaemonSet" || node.kind === "Job") return `${node.kind}/${node.name}`;
  return null;
}

export function buildOverlay(graph: TopologyGraph, overview: NetworkPolicyOverview): NetpolOverlay {
  const byKey = new Map(overview.workloads.map((w) => [`${w.kind}/${w.name}`, w]));
  const badges = new Map<string, IsolationBadge>();
  const status = new Map<string, WorkloadPolicyStatus>();
  const nodeByKey = new Map<string, string>();
  for (const node of graph.nodes) {
    const key = workloadKeyOfNode(node, graph);
    if (!key) continue;
    const w = byKey.get(key);
    if (!w) continue;
    badges.set(node.id, badgeFor(w));
    status.set(node.id, w);
    // Prefer the workload node itself as the flow endpoint; fall back to any node of it.
    if (node.kind !== "Pod" && node.kind !== "ReplicaSet") nodeByKey.set(key, node.id);
    else if (!nodeByKey.has(key)) nodeByKey.set(key, node.id);
  }
  const flows: NetpolOverlay["flows"] = [];
  for (const f of overview.flows) {
    const from = nodeByKey.get(f.from);
    const to = nodeByKey.get(f.to);
    if (from && to && from !== to) flows.push({ from, to, ports: f.ports, policy: f.policy });
  }
  return { badges, flows, status };
}

export function describePeer(p: WorkloadPolicyStatus["allowed_from"]): string {
  if (p.any) return "anything";
  const parts: string[] = [];
  if (p.workloads.length) parts.push(p.workloads.join(", "));
  if (p.namespaces.length) parts.push(p.namespaces.includes("*") ? "every namespace" : `ns ${p.namespaces.join(", ")}`);
  if (p.cidrs.length) parts.push(p.cidrs.join(", "));
  return parts.length ? parts.join(" · ") : "nothing";
}

export function unusedPolicies(overview: NetworkPolicyOverview): string[] {
  return overview.policies.filter((p) => p.selects.length === 0 && !p.selects_all).map((p) => p.name);
}

export function flowsTouching(flows: AllowedFlow[], key: string): AllowedFlow[] {
  return flows.filter((f) => f.from === key || f.to === key);
}
