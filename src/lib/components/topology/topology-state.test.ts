import { describe, expect, test } from "bun:test";
import type { TopologyEdge, TopologyNode } from "$lib/types";
import { edgeStateColors, nodeStateColor } from "./topology-state";

const node = (id: string, status?: string) => ({ id, status }) as TopologyNode;

describe("nodeStateColor", () => {
  test("a healthy node stays quiet", () => {
    expect(nodeStateColor(node("a", "Running"))).toBeNull();
  });

  test("a node with no status has nothing to say", () => {
    expect(nodeStateColor(node("a"))).toBeNull();
  });

  test("a crash loop is a failure, not an unknown status", () => {
    expect(nodeStateColor(node("a", "CrashLoopBackOff"))).toBe("var(--status-failed)");
  });
});

describe("edgeStateColors", () => {
  test("only edges into a node that needs a look are coloured", () => {
    const nodes = [node("rs", "Running"), node("ok", "Running"), node("bad", "CrashLoopBackOff")];
    const edges = [{ from: "rs", to: "ok" }, { from: "rs", to: "bad" }] as TopologyEdge[];
    expect([...edgeStateColors(nodes, edges)]).toEqual([["rs-bad", "var(--status-failed)"]]);
  });
});
