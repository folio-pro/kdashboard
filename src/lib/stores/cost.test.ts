import { describe, expect, test, beforeEach } from "bun:test";
import { CostStoreLogic, METRICS_TTL_MS } from "./cost.logic";

describe("CostStore", () => {
  let store: CostStoreLogic;

  beforeEach(() => {
    store = new CostStoreLogic();
  });

  // --- Initial state ---

  test("starts with null overview and no loading", () => {
    expect(store.overview).toBeNull();
    expect(store.data).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
  });

  test("starts with empty node costs and metrics", () => {
    expect(store.nodeCosts).toEqual({});
    expect(store.nodeMetrics).toEqual({});
  });

  test("overview getter aliases data", () => {
    const mockData = { total_cost_hourly: 1, total_cost_monthly: 720, source: "opencost", namespaces: [] };
    store.data = mockData as any;
    expect(store.overview as unknown).toBe(mockData);
  });

  // --- getNodeCost ---

  test("getNodeCost returns cost for known node", () => {
    store.nodeCosts = {
      "node-1": {
        node_name: "node-1",
        instance_type: "m5.xlarge",
        provider: "aws",
        region: "us-east-1",
        price_per_hour: 0.192,
        price_per_month: 138.24,
      } as any,
    };
    expect(store.getNodeCost("node-1")).toBeDefined();
    expect(store.getNodeCost("node-1")!.price_per_hour).toBe(0.192);
  });

  test("getNodeCost returns undefined for unknown node", () => {
    expect(store.getNodeCost("nonexistent")).toBeUndefined();
  });

  // --- getNodeMetrics ---

  test("getNodeMetrics returns metrics for known node", () => {
    store.nodeMetrics = {
      "node-1": { node_name: "node-1", cpu_usage: 0.45, memory_usage: 0.72 } as any,
    };
    expect(store.getNodeMetrics("node-1")).toBeDefined();
    expect(store.getNodeMetrics("node-1")!.cpu_usage).toBe(0.45);
  });

  test("getNodeMetrics returns undefined for unknown node", () => {
    expect(store.getNodeMetrics("nonexistent")).toBeUndefined();
  });

  // --- reset ---

  test("reset clears all state", () => {
    store.data = { total_cost_hourly: 1, total_cost_monthly: 720, source: "opencost", namespaces: [] } as any;
    store.isLoading = true;
    store.error = "some error";
    store.nodeCosts = { "node-1": {} as any };
    store.nodeMetrics = { "node-1": {} as any };
    store._metricsFetchedAt = Date.now();
    store._nodeLoading = true;
    store._metricsLoading = true;

    const prevLoadId = (store as any)._loadId;
    store.reset();

    expect(store.overview).toBeNull();
    expect(store.data).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.nodeCosts).toEqual({});
    expect(store.nodeMetrics).toEqual({});
    expect(store._nodeLoading).toBe(false);
    expect(store._metricsLoading).toBe(false);
    expect(store._metricsFetchedAt).toBe(0);
    expect((store as any)._loadId).toBe(prevLoadId + 1);
  });

  test("reset increments loadId to invalidate in-flight requests", () => {
    const id1 = (store as any)._loadId;
    store.reset();
    expect((store as any)._loadId).toBe(id1 + 1);
    store.reset();
    expect((store as any)._loadId).toBe(id1 + 2);
  });

  // --- METRICS_TTL_MS ---

  test("metrics TTL is 30 seconds", () => {
    expect(METRICS_TTL_MS).toBe(30_000);
  });
});
