import { describe, expect, test, beforeEach } from "bun:test";
import { TopologyStoreLogic } from "./topology.logic";

describe("TopologyStore", () => {
  let store: TopologyStoreLogic;

  beforeEach(() => {
    store = new TopologyStoreLogic();
  });

  // --- Initial state ---

  test("starts with null graph and no selection", () => {
    expect(store.graph).toBeNull();
    expect(store.data).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.selectedNodeId).toBeNull();
    expect(store.focusedResourceUid).toBeNull();
    expect(store.expandedClusters.size).toBe(0);
  });

  // --- selectNode ---

  test("selectNode sets selectedNodeId", () => {
    store.selectNode("uid-123");
    expect(store.selectedNodeId).toBe("uid-123");
  });

  test("selectNode with null clears selection", () => {
    store.selectNode("uid-123");
    store.selectNode(null);
    expect(store.selectedNodeId).toBeNull();
  });

  test("selectNode replaces previous selection", () => {
    store.selectNode("uid-1");
    store.selectNode("uid-2");
    expect(store.selectedNodeId).toBe("uid-2");
  });

  // --- toggleClusterExpansion ---

  test("toggleClusterExpansion adds new cluster", () => {
    store.toggleClusterExpansion("ctrl-1");
    expect(store.expandedClusters.has("ctrl-1")).toBe(true);
  });

  test("toggleClusterExpansion removes existing cluster", () => {
    store.toggleClusterExpansion("ctrl-1");
    store.toggleClusterExpansion("ctrl-1");
    expect(store.expandedClusters.has("ctrl-1")).toBe(false);
  });

  test("toggleClusterExpansion handles multiple clusters", () => {
    store.toggleClusterExpansion("ctrl-1");
    store.toggleClusterExpansion("ctrl-2");
    store.toggleClusterExpansion("ctrl-3");

    expect(store.expandedClusters.has("ctrl-1")).toBe(true);
    expect(store.expandedClusters.has("ctrl-2")).toBe(true);
    expect(store.expandedClusters.has("ctrl-3")).toBe(true);
    expect(store.expandedClusters.size).toBe(3);
  });

  test("toggleClusterExpansion creates new Set each time (immutability)", () => {
    const before = store.expandedClusters;
    store.toggleClusterExpansion("ctrl-1");
    expect(store.expandedClusters).not.toBe(before);
  });

  // --- graph getter ---

  test("graph getter aliases data", () => {
    const mockGraph = { nodes: [{ uid: "1", kind: "Pod", name: "p" }], edges: [] };
    store.data = mockGraph as any;
    expect(store.graph as unknown).toBe(mockGraph);
  });

  // --- reset ---

  test("reset clears all state", () => {
    store.data = { nodes: [{ uid: "1", kind: "Pod", name: "p" }], edges: [] } as any;
    store.isLoading = true;
    store.error = "timeout";
    store.selectedNodeId = "uid-1";
    store.focusedResourceUid = "uid-2";
    store.expandedClusters = new Set(["ctrl-1"]);

    const prevLoadId = (store as any)._loadId;
    store.reset();

    expect(store.graph).toBeNull();
    expect(store.data).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.selectedNodeId).toBeNull();
    expect(store.focusedResourceUid).toBeNull();
    expect(store.expandedClusters.size).toBe(0);
    expect((store as any)._loadId).toBe(prevLoadId + 1);
  });

  test("reset increments loadId to invalidate stale responses", () => {
    store.reset();
    store.reset();
    expect((store as any)._loadId).toBe(2);
  });
});
