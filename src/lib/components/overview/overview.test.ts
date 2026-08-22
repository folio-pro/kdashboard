import { describe, expect, test } from "bun:test";
import type { ClusterOverview, NodeSummary, Problem } from "$lib/types";
import {
  EMPTY_PROBLEM_FILTER,
  countByKind,
  countBySeverity,
  filterProblems,
  nodeNeedsAttention,
  nodePressure,
  overviewTiles,
  pct,
  problemResourceType,
  topReasons,
} from "./overview.logic";

const node = (over: Partial<NodeSummary> = {}): NodeSummary => ({
  name: "n", ready: true, pressure: [], unschedulable: false, instance_type: null, zone: null, kubelet_version: null,
  cpu_allocatable: 4, memory_allocatable: 16e9, cpu_requests: 2, memory_requests: 8e9, pod_count: 10, cpu_usage: null, memory_usage: null, age: null,
  ...over,
});
const problem = (over: Partial<Problem> = {}): Problem => ({
  id: "Pod/ns/p", severity: "critical", kind: "Pod", name: "p", namespace: "ns", reason: "CrashLoopBackOff", detail: null, owner: null, since: null, restarts: 0, ready: null, desired: null, ...over,
});
const overview = (over: Partial<ClusterOverview> = {}): ClusterOverview => ({
  scope: "cluster", namespace: null, nodes: [node(), node({ name: "m", pressure: ["MemoryPressure"] })],
  pods: { running: 284, pending: 9, succeeded: 15, failed: 4, unknown: 0, total: 312 },
  problems: [problem(), problem({ id: "x", severity: "warning", kind: "Deployment" })],
  warnings: [{ reason: "BackOff", message: "", kind: "Pod", name: "p", namespace: "ns", count: 1, last_timestamp: null }, { reason: "BackOff", message: "", kind: "Pod", name: "q", namespace: "ns", count: 1, last_timestamp: null }, { reason: "Unhealthy", message: "", kind: "Pod", name: "r", namespace: "ns", count: 1, last_timestamp: null }],
  warnings_total: 17, top_pods_cpu: [], top_pods_memory: [], metrics_available: false, partial: [], fetched_at: "",
  ...over,
});

describe("node helpers", () => {
  test("pct clamps and handles zero", () => {
    expect(pct(2, 4)).toBe(50);
    expect(pct(5, 4)).toBe(100);
    expect(pct(1, 0)).toBe(0);
  });
  test("nodePressure is null without requests; attention rules", () => {
    expect(nodePressure(node())).toEqual({ cpu: 50, memory: 50 });
    expect(nodePressure(node({ cpu_requests: null, memory_requests: null }))).toEqual({ cpu: null, memory: null });
    expect(nodeNeedsAttention(node())).toBe(false);
    expect(nodeNeedsAttention(node({ ready: false }))).toBe(true);
    expect(nodeNeedsAttention(node({ unschedulable: true }))).toBe(true);
    expect(nodeNeedsAttention(node({ cpu_requests: 3.8 }))).toBe(true);
  });
});

describe("problem helpers", () => {
  const list = [problem(), problem({ id: "b", severity: "warning", kind: "Deployment", name: "web", namespace: "shop", reason: "2/3 ready" }), problem({ id: "c", kind: "Node", name: "ip-1", namespace: null, reason: "NotReady" })];
  test("counts", () => {
    expect(countBySeverity(list)).toEqual({ critical: 2, warning: 1 });
    expect(countByKind(list)).toEqual({ Pod: 1, Deployment: 1, Node: 1 });
  });
  test("filters by severity, kind and free text", () => {
    expect(filterProblems(list, EMPTY_PROBLEM_FILTER)).toHaveLength(3);
    expect(filterProblems(list, { ...EMPTY_PROBLEM_FILTER, severity: "warning" }).map((p) => p.name)).toEqual(["web"]);
    expect(filterProblems(list, { ...EMPTY_PROBLEM_FILTER, kind: "Node" }).map((p) => p.name)).toEqual(["ip-1"]);
    expect(filterProblems(list, { ...EMPTY_PROBLEM_FILTER, text: "SHOP" }).map((p) => p.name)).toEqual(["web"]);
    expect(filterProblems(list, { ...EMPTY_PROBLEM_FILTER, text: "notready" }).map((p) => p.name)).toEqual(["ip-1"]);
  });
  test("problemResourceType maps kinds to plurals", () => {
    expect(problemResourceType("Deployment")).toBe("deployments");
    expect(problemResourceType("Node")).toBe("nodes");
  });
});

describe("overview tiles", () => {
  test("summarise nodes, pods, problems and warnings with tones", () => {
    const tiles = overviewTiles(overview());
    expect(tiles.map((t) => [t.label, t.value, t.tone])).toEqual([
      ["Nodes", "2/2", "warning"],
      ["Pods", "312", "error"],
      ["Problems", "2", "error"],
      ["Warnings · last hour", "17", "warning"],
    ]);
    expect(tiles[0].note).toBe("1 under pressure");
    expect(tiles[1].note).toBe("284 Running · 9 Pending · 4 Failed · 15 Succeeded");
    expect(tiles[2].note).toBe("1 critical · 1 warning");
    expect(tiles[3].note).toBe("2 BackOff · 1 Unhealthy");
  });
  test("a quiet cluster reads green", () => {
    const tiles = overviewTiles(overview({ nodes: [node()], pods: { running: 3, pending: 0, succeeded: 0, failed: 0, unknown: 0, total: 3 }, problems: [], warnings: [], warnings_total: 0 }));
    expect(tiles.map((t) => t.tone)).toEqual(["success", "success", "success", "success"]);
    expect(tiles[0].note).toBe("all Ready");
  });
  test("topReasons orders by count then name", () => {
    expect(topReasons(["b", "a", "b", "c", "a"], 2)).toBe("2 a · 2 b");
  });
});
