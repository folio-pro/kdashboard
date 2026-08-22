import { describe, expect, test } from "bun:test";
import type { NetworkPolicyOverview, TopologyGraph, WorkloadPolicyStatus } from "$lib/types";
import { badgeFor, buildOverlay, describePeer, unusedPolicies } from "./netpol-layer.logic";

const ws = (kind: string, name: string, ing: boolean, eg: boolean): WorkloadPolicyStatus => ({
  kind, name, pod_count: 1, isolated_ingress: ing, isolated_egress: eg, policies: [], allowed_from: { any: false, workloads: [], namespaces: [], cidrs: [], ports: [] }, allowed_to: { any: false, workloads: [], namespaces: [], cidrs: [], ports: [] },
});
const graph: TopologyGraph = {
  nodes: [
    { id: "svc", kind: "Service", name: "web", api_version: "v1", is_ghost: false, depth: 0 },
    { id: "dep", kind: "Deployment", name: "web", api_version: "apps/v1", is_ghost: false, depth: 1 },
    { id: "rs", kind: "ReplicaSet", name: "web-7f9c8d", api_version: "apps/v1", is_ghost: false, depth: 2 },
    { id: "pod", kind: "Pod", name: "web-7f9c8d-x", api_version: "v1", is_ghost: false, depth: 3 },
    { id: "api", kind: "Deployment", name: "api", api_version: "apps/v1", is_ghost: false, depth: 1 },
  ],
  edges: [{ from: "svc", to: "dep", edge_type: "selects" }, { from: "dep", to: "rs", edge_type: "owns" }, { from: "rs", to: "pod", edge_type: "owns" }],
  root_ids: ["svc"], has_cycles: false, total_resources: 5, clustered: false, cluster_groups: [],
};
const overview: NetworkPolicyOverview = {
  namespace: "shop", policy_count: 2, default_deny_ingress: true, default_deny_egress: false,
  policies: [{ name: "deny", policy_types: ["Ingress"], selects: ["Deployment/web", "Deployment/api"], pod_count: 2, selects_all: true, ingress_rules: 0, egress_rules: 0 }, { name: "orphan", policy_types: ["Ingress"], selects: [], pod_count: 0, selects_all: false, ingress_rules: 1, egress_rules: 0 }],
  workloads: [ws("Deployment", "web", true, false), ws("Deployment", "api", true, true)],
  flows: [{ from: "Deployment/web", to: "Deployment/api", ports: ["8080"], policy: "allow" }],
  fetched_at: "",
};

describe("netpol overlay", () => {
  test("badges", () => {
    expect(badgeFor(ws("D", "x", true, true))).toBe("isolated");
    expect(badgeFor(ws("D", "x", true, false))).toBe("partial");
    expect(badgeFor(ws("D", "x", false, false))).toBe("open");
  });
  test("maps workloads onto deployment, replicaset and pod nodes, and flows onto workload nodes", () => {
    const o = buildOverlay(graph, overview);
    expect(o.badges.get("dep")).toBe("partial");
    expect(o.badges.get("rs")).toBe("partial");
    expect(o.badges.get("pod")).toBe("partial");
    expect(o.badges.get("api")).toBe("isolated");
    expect(o.badges.has("svc")).toBe(false);
    expect(o.flows).toEqual([{ from: "dep", to: "api", ports: ["8080"], policy: "allow" }]);
    expect(o.status.get("pod")?.name).toBe("web");
  });
  test("describePeer and unusedPolicies", () => {
    expect(describePeer({ any: true, workloads: [], namespaces: [], cidrs: [], ports: [] })).toBe("anything");
    expect(describePeer({ any: false, workloads: ["Deployment/web"], namespaces: ["*"], cidrs: ["10.0.0.0/8"], ports: [] })).toBe("Deployment/web · every namespace · 10.0.0.0/8");
    expect(describePeer({ any: false, workloads: [], namespaces: [], cidrs: [], ports: [] })).toBe("nothing");
    expect(unusedPolicies(overview)).toEqual(["orphan"]);
  });
});
