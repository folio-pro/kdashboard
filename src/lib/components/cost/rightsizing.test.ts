import { describe, expect, test } from "bun:test";
import type { ContainerRightsizing, WorkloadRightsizing } from "$lib/types";
import { changedContainers, cpuQuantity, filterWorkloads, formatSaving, memoryQuantity, rightsizingPatchYaml, usageShare } from "./rightsizing.logic";

const MI = 1024 * 1024;
const container = (over: Partial<ContainerRightsizing> = {}): ContainerRightsizing => ({
  container: "app", cpu_request: 1, memory_request: 1024 * MI, cpu_limit: null, memory_limit: null,
  cpu_usage: 0.15, memory_usage: 250 * MI, cpu_recommended: 0.2, memory_recommended: 320 * MI,
  cpu_verdict: "over", memory_verdict: "over", ...over,
});
const workload = (over: Partial<WorkloadRightsizing> = {}): WorkloadRightsizing => ({
  id: "Deployment/shop/web", kind: "Deployment", name: "web", namespace: "shop", replicas: 2,
  containers: [container()], verdict: "over", saving_monthly: 41.7, cpu_delta: 1.6, memory_delta: 1408 * MI, ...over,
});

describe("quantities", () => {
  test("cpu and memory render as kubectl would", () => {
    expect(cpuQuantity(0.2)).toBe("200m");
    expect(cpuQuantity(1.25)).toBe("1250m");
    expect(cpuQuantity(2)).toBe("2");
    expect(memoryQuantity(320 * MI)).toBe("320Mi");
    expect(memoryQuantity(2048 * MI)).toBe("2Gi");
  });
  test("savings round to whole dollars with a sign", () => {
    expect(formatSaving(41.7)).toBe("$42");
    expect(formatSaving(-3.2)).toBe("−$3");
    expect(formatSaving(0.1)).toBe("<$1");
  });
});

describe("patch", () => {
  test("emits an SSA manifest touching only the containers that change", () => {
    const w = workload({ containers: [container(), container({ container: "sidecar", cpu_verdict: "ok", memory_verdict: "ok" })] });
    expect(changedContainers(w)).toEqual([{ name: "app", cpu: "200m", memory: "320Mi" }]);
    expect(rightsizingPatchYaml(w)).toBe(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          resources:\n            requests:\n              cpu: 200m\n              memory: 320Mi\n",
    );
  });
  test("no patch for bare pods, jobs, or nothing to change", () => {
    expect(rightsizingPatchYaml(workload({ kind: "Pod" }))).toBeNull();
    expect(rightsizingPatchYaml(workload({ kind: "Job" }))).toBeNull();
    expect(rightsizingPatchYaml(workload({ containers: [container({ cpu_verdict: "ok", memory_verdict: "ok" })] }))).toBeNull();
  });
  test("a container with no request gets one set from the recommendation", () => {
    const w = workload({ containers: [container({ cpu_request: null, cpu_verdict: "no-request", memory_verdict: "ok" })] });
    expect(changedContainers(w)).toEqual([{ name: "app", cpu: "200m", memory: null }]);
  });
});

describe("filters and bars", () => {
  test("filterWorkloads by verdict and text", () => {
    const ws = [workload(), workload({ id: "b", name: "kafka", namespace: "msg", verdict: "under" }), workload({ id: "c", name: "fine", verdict: "ok" })];
    expect(filterWorkloads(ws, "all", "").map((w) => w.name)).toEqual(["web", "kafka", "fine"]);
    expect(filterWorkloads(ws, "over", "").map((w) => w.name)).toEqual(["web"]);
    expect(filterWorkloads(ws, "under", "").map((w) => w.name)).toEqual(["kafka"]);
    expect(filterWorkloads(ws, "all", "MSG").map((w) => w.name)).toEqual(["kafka"]);
  });
  test("usageShare caps at 150 and is null without data", () => {
    expect(usageShare(container(), "cpu")).toBe(15);
    expect(usageShare(container({ cpu_usage: 3 }), "cpu")).toBe(150);
    expect(usageShare(container({ memory_request: null }), "memory")).toBeNull();
  });
});
