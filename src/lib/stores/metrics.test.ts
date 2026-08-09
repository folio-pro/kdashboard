import { test, expect, describe } from "bun:test";

import type { PodUsageInfo, Resource } from "$lib/types";
import {
  MetricsStoreLogic,
  POD_METRICS_TTL_MS,
  cpuCell,
  formatBytes,
  formatCpu,
  memoryCell,
  parseCpuQuantity,
  parseMemoryQuantity,
  podKey,
  podLimits,
  podRequests,
} from "./metrics.logic";

function pod(
  requests?: { cpu?: string; memory?: string },
  initRequests?: { cpu?: string },
  limits?: { cpu?: string; memory?: string },
): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name: "web",
      namespace: "prod",
      uid: "u1",
      creation_timestamp: "",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {
      containers: [
        {
          name: "app",
          resources: requests || limits ? { requests, limits } : undefined,
        },
      ],
      initContainers: initRequests ? [{ name: "init", resources: { requests: initRequests } }] : [],
    },
    status: {},
  } as Resource;
}

const usage = (cpu: number, mem: number): PodUsageInfo => ({
  name: "web",
  namespace: "prod",
  cpu_cores: cpu,
  memory_bytes: mem,
  containers: [],
});

describe("quantity parsing", () => {
  test("CPU suffixes resolve to cores", () => {
    expect(parseCpuQuantity("250m")).toBeCloseTo(0.25);
    expect(parseCpuQuantity("2")).toBe(2);
    expect(parseCpuQuantity("1500u")).toBeCloseTo(0.0015);
    expect(parseCpuQuantity("3000000n")).toBeCloseTo(0.003);
  });

  test("memory suffixes resolve to bytes, binary and decimal", () => {
    expect(parseMemoryQuantity("128Mi")).toBe(128 * 1024 * 1024);
    expect(parseMemoryQuantity("1Gi")).toBe(1024 ** 3);
    expect(parseMemoryQuantity("512M")).toBe(512e6);
    expect(parseMemoryQuantity("2048")).toBe(2048);
  });
});

describe("formatting", () => {
  test("CPU renders as millicores below a core", () => {
    expect(formatCpu(0.12)).toBe("120m");
    expect(formatCpu(1.5)).toBe("1.50");
    expect(formatCpu(4)).toBe("4");
    expect(formatCpu(0)).toBe("0m");
  });

  test("bytes step up to the largest readable binary unit", () => {
    expect(formatBytes(0)).toBe("0");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 Ki");
    expect(formatBytes(700 * 1024 * 1024)).toBe("700 Mi");
  });
});

function assert_shape(
  cell: { label: string; percent: number | null; basis: string | null; basisLabel: string },
  expected: { label: string; percent: number; basis: string; basisLabel: string },
): void {
  expect(cell.label).toBe(expected.label);
  expect(cell.percent).toBe(expected.percent);
  expect(cell.basis).toBe(expected.basis);
  expect(cell.basisLabel).toBe(expected.basisLabel);
}

describe("podRequests / podLimits", () => {
  test("limits are summed independently of requests", () => {
    const p = pod({ cpu: "100m", memory: "64Mi" }, undefined, { cpu: "1", memory: "256Mi" });
    expect(podLimits(p)).toEqual({ cpu: 1, memory: 256 * 1024 * 1024 });
    expect(podRequests(p)).toEqual({ cpu: 0.1, memory: 64 * 1024 * 1024 });
  });

  test("a pod with no limits sums to zero", () => {
    expect(podLimits(pod({ cpu: "100m" }))).toEqual({ cpu: 0, memory: 0 });
  });
});

describe("podRequests", () => {
  test("sums container requests", () => {
    expect(podRequests(pod({ cpu: "250m", memory: "128Mi" }))).toEqual({
      cpu: 0.25,
      memory: 128 * 1024 * 1024,
    });
  });

  test("is zero when nothing is requested", () => {
    expect(podRequests(pod())).toEqual({ cpu: 0, memory: 0 });
  });

  test("ignores init containers — they do not run alongside the app", () => {
    expect(podRequests(pod({ cpu: "100m" }, { cpu: "2" })).cpu).toBeCloseTo(0.1);
  });
});

describe("usage cells", () => {
  test("percent is relative to the request when there is no limit", () => {
    const cell = cpuCell(pod({ cpu: "200m" }), usage(0.1, 0))!;
    assert_shape(cell, { label: "100m", percent: 50, basis: "request", basisLabel: "200m" });
    expect(cell.limitLabel).toBe("");
  });

  test("a limit wins over the request as the bar's basis", () => {
    const cell = cpuCell(pod({ cpu: "100m" }, undefined, { cpu: "500m" }), usage(0.25, 0))!;
    assert_shape(cell, { label: "250m", percent: 50, basis: "limit", basisLabel: "500m" });
    // Both still surface, so the tooltip can explain the fill.
    expect(cell.requestLabel).toBe("100m");
    expect(cell.limitLabel).toBe("500m");
  });

  test("no request and no limit leaves a value but nothing to fill", () => {
    const cell = memoryCell(pod(), usage(0, 1024))!;
    expect(cell.percent).toBeNull();
    expect(cell.basis).toBeNull();
    expect(cell.basisLabel).toBe("");
  });

  test("no usage yields no cell at all", () => {
    expect(cpuCell(pod({ cpu: "1" }), undefined)).toBeNull();
  });

  test("usage above the basis exceeds 100%", () => {
    expect(cpuCell(pod({ cpu: "100m" }), usage(0.25, 0))!.percent).toBe(250);
  });
});

describe("MetricsStoreLogic", () => {
  test("indexes usage by namespace/name", () => {
    const store = new MetricsStoreLogic();
    store.applyPodUsage([usage(1, 2)], 1000);
    expect(store.getPodUsage("prod", "web")).toBeDefined();
    expect(store.getPodUsage("staging", "web")).toBeUndefined();
    expect(podKey("prod", "web")).toBe("prod/web");
  });

  test("is stale before the first fetch and again after the TTL", () => {
    const store = new MetricsStoreLogic();
    expect(store.isStale(0)).toBe(true);
    store.applyPodUsage([], 10_000);
    expect(store.isStale(10_000 + POD_METRICS_TTL_MS - 1)).toBe(false);
    expect(store.isStale(10_000 + POD_METRICS_TTL_MS)).toBe(true);
  });

  test("reset clears usage and re-enables availability", () => {
    const store = new MetricsStoreLogic();
    store.applyPodUsage([usage(1, 1)], 1);
    store.podMetricsAvailable = false;
    store.reset();
    expect(store.podUsage).toEqual({});
    expect(store.podMetricsAvailable).toBe(true);
    expect(store.isStale(0)).toBe(true);
  });
});
