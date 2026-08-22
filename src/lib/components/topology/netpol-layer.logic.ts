// Pure mapping from the NetworkPolicy overview onto topology node ids.

import type { AllowedFlow, NetworkPolicyOverview, TopologyGraph, WorkloadPolicyStatus } from "$lib/types";
import { controllerWorkload } from "$lib/utils/pod-status";

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

const WORKLOAD_KINDS: ReadonlySet<string> = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job"]);

/** The workload node key ("Kind/name") a topology node belongs to: pods via their owner edge, ReplicaSets via their Deployment. */
function workloadKeyOfNode(node: TopologyGraph["nodes"][number], graph: TopologyGraph): string | null {
  if (node.kind === "Pod") {
    const owner = graph.edges.find((e) => e.to === node.id && e.edge_type === "owns");
    const parent = owner ? graph.nodes.find((n) => n.id === owner.from) : undefined;
    if (!parent) return `Pod/${node.name}`;
    const w = controllerWorkload(parent);
    return `${w.kind}/${w.name}`;
  }
  if (node.kind === "ReplicaSet") {
    const w = controllerWorkload(node);
    return `${w.kind}/${w.name}`;
  }
  return WORKLOAD_KINDS.has(node.kind) ? `${node.kind}/${node.name}` : null;
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

/** How many workloads are isolated both ways, one way, or not at all. */
export function isolationCounts(overview: NetworkPolicyOverview): { isolated: number; partial: number; open: number } {
  const c = { isolated: 0, partial: 0, open: 0 };
  for (const w of overview.workloads) c[badgeFor(w)]++;
  return c;
}
