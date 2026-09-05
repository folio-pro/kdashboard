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

// ---------------------------------------------------------------------------
// Layout + fit geometry
// ---------------------------------------------------------------------------

import { fitViewBox, layoutTopology, maxNodesPerRow, MIN_FIT_SCALE, TOPOLOGY_METRICS } from "./topology.logic";
import type { TopologyNode } from "$lib/types";

function node(id: string, depth: number, kind = "Pod"): TopologyNode {
  return { id, kind, name: id, api_version: "v1", is_ghost: false, depth };
}

describe("topology layout", () => {
  const m = TOPOLOGY_METRICS;

  test("maxNodesPerRow spans the viewport at the minimum zoom", () => {
    // 1000px wide at 0.75 = 1333 units, minus padding: six 180+40 slots.
    expect(maxNodesPerRow(1000)).toBe(5);
    expect(maxNodesPerRow(2000)).toBe(11);
    expect(maxNodesPerRow(0)).toBe(6);
    expect(maxNodesPerRow(10)).toBe(1);
  });

  test("a wide layer wraps into rows instead of one strip", () => {
    const nodes = [node("deploy", 0, "Deployment"), ...Array.from({ length: 12 }, (_, i) => node(`pod-${i}`, 1))];
    const layout = layoutTopology(nodes, 5);
    // 12 pods at 5 per row = 3 rows; width is the widest row, not 12 nodes.
    expect(layout.width).toBe(5 * (m.nodeWidth + m.gapX) - m.gapX + m.padding * 2);
    const ys = new Set([...layout.positions.entries()].filter(([id]) => id.startsWith("pod")).map(([, p]) => p.y));
    expect(ys.size).toBe(3);
    // Rows inside a layer are rowGapY apart; the layer sits layerGapY under its parent.
    const [r0, r1] = [...ys].sort((a, b) => a - b);
    expect(r1 - r0).toBe(m.nodeHeight + m.rowGapY);
    expect(r0 - layout.positions.get("deploy")!.y).toBe(m.nodeHeight + m.layerGapY);
    expect(layout.height).toBe(r0 + 2 * (m.nodeHeight + m.rowGapY) + m.nodeHeight + m.padding);
  });

  test("rows are centred on the widest and sorted by kind then name", () => {
    const layout = layoutTopology([node("b", 0, "Service"), node("a", 0, "Deployment"), node("c", 1)], 10);
    expect(layout.positions.get("a")!.x).toBeLessThan(layout.positions.get("b")!.x);
    // The single child sits under the middle of the two-node row.
    const rowCentre = (layout.positions.get("a")!.x + layout.positions.get("b")!.x) / 2;
    expect(layout.positions.get("c")!.x).toBe(rowCentre);
  });

  test("an empty graph still yields a sane box", () => {
    const layout = layoutTopology([], 5);
    expect(layout.positions.size).toBe(0);
    expect(layout.width).toBe(m.padding * 2);
    expect(layout.height).toBe(m.padding * 2);
  });
});

describe("fitViewBox", () => {
  test("a small graph is centred without being blown past the max zoom", () => {
    const box = fitViewBox({ width: 400, height: 200 }, { width: 1200, height: 800 });
    // Scale clamps at 1.25: the box is the viewport / 1.25, centred on the content.
    expect(box.w).toBeCloseTo(960);
    expect(box.h).toBeCloseTo(640);
    expect(box.x).toBeCloseTo((400 - 960) / 2);
    expect(box.y).toBeCloseTo((200 - 640) / 2);
  });

  test("a graph that fits between the clamps is fitted exactly", () => {
    const box = fitViewBox({ width: 1200, height: 400 }, { width: 1200, height: 800 });
    expect(box.w).toBeCloseTo(1200);
    expect(box.h).toBeCloseTo(800);
    expect(box.x).toBeCloseTo(0);
    expect(box.y).toBeCloseTo(-200);
  });

  test("a tall graph stops at the readable minimum and starts from the top", () => {
    const box = fitViewBox({ width: 1200, height: 4000 }, { width: 1200, height: 800 });
    expect(box.w).toBeCloseTo(1200 / MIN_FIT_SCALE);
    expect(box.h).toBeCloseTo(800 / MIN_FIT_SCALE);
    expect(box.y).toBe(0);
    expect(box.x).toBeCloseTo((1200 - 1600) / 2);
  });

  test("an unmeasured viewport falls back to a default size", () => {
    const box = fitViewBox({ width: 100, height: 100 }, { width: 0, height: 0 });
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
  });
});
