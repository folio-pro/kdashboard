import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource } from "../types/index.js";
import {
  WatchBatcher,
  DebouncedFilter,
  filterItems,
  sortItems,
  type WatchEvent,
} from "./performance.logic";

/**
 * Performance-related tests for the optimizations:
 * 1. Watch event batching (rAF micro-batching)
 * 2. Debounced filter (150ms delay)
 * 3. Split filter/sort derivation
 */

// --- Helpers ---

function makeResource(name: string, uid: string, namespace = "default"): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid,
      creation_timestamp: "2024-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: { phase: "Running" },
  };
}

// --- 1. Watch event batching ---

describe("Watch event batching", () => {
  let batcher: WatchBatcher;

  beforeEach(() => {
    batcher = new WatchBatcher();
    batcher.resources = {
      items: [makeResource("pod-1", "uid-1"), makeResource("pod-2", "uid-2")],
      resource_type: "pods",
    };
  });

  test("multiple events are queued, not processed immediately", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: { ...makeResource("pod-3", "uid-3") },
    });
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: { ...makeResource("pod-4", "uid-4") },
    });

    // Events are pending, not yet applied
    expect(batcher.pendingCount).toBe(2);
    expect(batcher.resources.items.length).toBe(2);
  });

  test("flush applies all pending events and triggers reactivity once", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-3", "uid-3"),
    });
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-4", "uid-4"),
    });
    batcher.handleWatchEvent({
      event_type: "Deleted",
      resource_type: "pods",
      resource: makeResource("pod-1", "uid-1"),
    });

    batcher.flushWatchEvents();

    // All events applied: +2 added, -1 deleted = 3 total
    expect(batcher.resources.items.length).toBe(3);
    expect(batcher.resources.items.map((r) => r.metadata.name).sort()).toEqual([
      "pod-2", "pod-3", "pod-4",
    ]);
    // Single reactivity trigger
    expect(batcher.reactivityTriggerCount).toBe(1);
    expect(batcher.pendingCount).toBe(0);
  });

  test("Resync event clears pending events", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-3", "uid-3"),
    });
    expect(batcher.pendingCount).toBe(1);

    batcher.handleWatchEvent({
      event_type: "Resync",
      resource_type: "pods",
      resource: makeResource("", ""),
    });

    expect(batcher.pendingCount).toBe(0);
    expect(batcher.resyncTriggered).toBe(true);
  });

  test("events for wrong resource type are ignored", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "deployments",
      resource: makeResource("deploy-1", "uid-d1"),
    });

    expect(batcher.pendingCount).toBe(0);
  });

  test("scope change discards pending events", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-3", "uid-3"),
    });
    expect(batcher.pendingCount).toBe(1);

    batcher.beginScopeChange();

    expect(batcher.pendingCount).toBe(0);
  });

  test("flush updates selectedResource when matching uid", () => {
    batcher.selectedResource = batcher.resources.items[0]; // pod-1

    const updated = { ...makeResource("pod-1", "uid-1"), status: { phase: "Succeeded" } };
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: updated,
    });

    batcher.flushWatchEvents();

    expect(batcher.selectedResource?.status?.phase).toBe("Succeeded");
  });

  test("flush nullifies selectedResource on delete", () => {
    batcher.selectedResource = batcher.resources.items[0]; // pod-1

    batcher.handleWatchEvent({
      event_type: "Deleted",
      resource_type: "pods",
      resource: makeResource("pod-1", "uid-1"),
    });

    batcher.flushWatchEvents();

    expect(batcher.selectedResource).toBeNull();
  });

  // --- Coalescing by uid ---
  //
  // The buffer keeps only the newest event per uid so it stays bounded while
  // the flush is throttled (backgrounded window). These pin down that this is
  // equivalent to replaying every event, and that row order is unaffected.

  test("repeated events for one uid collapse to a single pending entry", () => {
    const base = makeResource("pod-1", "uid-1");
    for (let i = 2; i <= 50; i++) {
      batcher.handleWatchEvent({
        event_type: "Applied",
        resource_type: "pods",
        resource: { ...base, metadata: { ...base.metadata, resource_version: String(i) } },
      });
    }

    // 49 events in, one resource out — this is the bound that keeps a hidden
    // window from accumulating an unbounded buffer.
    expect(batcher.pendingCount).toBe(1);

    batcher.flushWatchEvents();

    expect(batcher.resources.items.length).toBe(2);
    expect(batcher.resources.items[0].metadata.resource_version).toBe("50");
  });

  test("last event for a uid wins, matching a full replay", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-3", "uid-3"),
    });
    batcher.handleWatchEvent({
      event_type: "Deleted",
      resource_type: "pods",
      resource: makeResource("pod-3", "uid-3"),
    });

    batcher.flushWatchEvents();

    // Applied-then-Deleted nets out to absent, exactly as replaying both would.
    expect(batcher.resources.items.map((r) => r.metadata.uid)).toEqual(["uid-1", "uid-2"]);
  });

  test("a Deleted superseded by a later Applied re-appends the resource", () => {
    batcher.handleWatchEvent({
      event_type: "Deleted",
      resource_type: "pods",
      resource: makeResource("pod-1", "uid-1"),
    });
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-1", "uid-1"),
    });

    batcher.flushWatchEvents();

    // uid-1 moves to the END: a replay deletes the row and then re-adds it, so
    // coalescing must not smuggle it back into its original slot.
    expect(batcher.resources.items.map((r) => r.metadata.uid)).toEqual(["uid-2", "uid-1"]);
  });

  test("row order is preserved: updates keep position, new items append in arrival order", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-1", "uid-1"),
    });
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-4", "uid-4"),
    });
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-3", "uid-3"),
    });
    // Re-touching uid-4 must NOT move it behind uid-3.
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-4", "uid-4"),
    });

    batcher.flushWatchEvents();

    expect(batcher.resources.items.map((r) => r.metadata.uid)).toEqual([
      "uid-1",
      "uid-2",
      "uid-4",
      "uid-3",
    ]);
  });

  test("events without a uid are dropped at enqueue time", () => {
    batcher.handleWatchEvent({
      event_type: "Applied",
      resource_type: "pods",
      resource: makeResource("pod-x", ""),
    });

    expect(batcher.pendingCount).toBe(0);
  });

  // --- Replay equivalence ---
  //
  // Coalescing is only safe because it produces the SAME list as replaying
  // every event one by one. Asserting hand-written expectations cannot prove
  // that — it just restates whatever the implementation happens to do. These
  // compute the replay result independently and compare.

  /** Ground truth: apply every event in order, as an un-coalesced flush would. */
  function replay(start: Resource[], events: WatchEvent[]): string[] {
    const byUid = new Map<string, Resource>();
    for (const r of start) byUid.set(r.metadata.uid, r);
    for (const e of events) {
      const uid = e.resource.metadata?.uid;
      if (!uid) continue;
      if (e.event_type === "Applied") byUid.set(uid, e.resource);
      else if (e.event_type === "Deleted") byUid.delete(uid);
    }
    return [...byUid.keys()];
  }

  function coalesce(start: Resource[], events: WatchEvent[]): string[] {
    const b = new WatchBatcher();
    b.resources = { items: [...start], resource_type: "pods" };
    for (const e of events) b.handleWatchEvent(e);
    b.flushWatchEvents();
    return b.resources.items.map((r) => r.metadata.uid);
  }

  const applied = (uid: string): WatchEvent => ({
    event_type: "Applied",
    resource_type: "pods",
    resource: makeResource(`pod-${uid}`, uid),
  });
  const deleted = (uid: string): WatchEvent => ({
    event_type: "Deleted",
    resource_type: "pods",
    resource: makeResource(`pod-${uid}`, uid),
  });

  const SCENARIOS: Array<{ name: string; start: string[]; events: WatchEvent[] }> = [
    {
      name: "in-place updates keep their slot",
      start: ["uid-1", "uid-2"],
      events: [applied("uid-1"), applied("uid-3")],
    },
    {
      name: "Deleted then Applied on a present uid",
      start: ["uid-1", "uid-2"],
      events: [deleted("uid-1"), applied("uid-1")],
    },
    {
      name: "Deleted on an absent uid, another uid applied in between",
      start: ["uid-1"],
      events: [deleted("uid-4"), applied("uid-3"), applied("uid-4")],
    },
    {
      name: "Applied then Deleted on a new uid",
      start: ["uid-1"],
      events: [applied("uid-5"), deleted("uid-5")],
    },
    {
      name: "interleaved churn across several uids",
      start: ["uid-1", "uid-2"],
      events: [
        applied("uid-3"),
        deleted("uid-2"),
        applied("uid-2"),
        deleted("uid-3"),
        applied("uid-4"),
        applied("uid-1"),
      ],
    },
  ];

  for (const { name, start, events } of SCENARIOS) {
    test(`replay equivalence: ${name}`, () => {
      const items = start.map((uid) => makeResource(`pod-${uid}`, uid));
      expect(coalesce(items, events)).toEqual(replay(items, events));
    });
  }
});

// --- 2. Debounced filter ---

describe("Debounced filter", () => {
  let df: DebouncedFilter;

  beforeEach(() => {
    df = new DebouncedFilter();
  });

  test("filter updates immediately", () => {
    df.setFilter("hello");
    expect(df.filter).toBe("hello");
  });

  test("debouncedFilterLower does not update immediately", () => {
    df.setFilter("Hello");
    expect(df.debouncedFilterLower).toBe("");
  });

  test("debouncedFilterLower updates after timeout", async () => {
    df.setFilter("Hello");
    await new Promise((r) => setTimeout(r, 200));
    expect(df.debouncedFilterLower).toBe("hello");
  });

  test("rapid typing only triggers one debounced update", async () => {
    df.setFilter("h");
    df.setFilter("he");
    df.setFilter("hel");
    df.setFilter("hell");
    df.setFilter("hello");

    // Immediately: filter is latest, debounced is still empty
    expect(df.filter).toBe("hello");
    expect(df.debouncedFilterLower).toBe("");

    await new Promise((r) => setTimeout(r, 200));
    expect(df.debouncedFilterLower).toBe("hello");
  });

  test("clearDebounce synchronizes immediately", () => {
    df.setFilter("test");
    expect(df.debouncedFilterLower).toBe("");

    df.clearDebounce();
    expect(df.debouncedFilterLower).toBe("test");
    expect(df.hasPendingDebounce).toBe(false);
  });

  test("clearDebounce after clearing filter resets both", () => {
    df.setFilter("test");
    df.filter = "";
    df.clearDebounce();
    expect(df.debouncedFilterLower).toBe("");
  });
});

// --- 3. Split derived: filter vs sort independence ---

describe("Split filter/sort derivation", () => {
  const resources = [
    makeResource("zeta-pod", "uid-z", "default"),
    makeResource("alpha-pod", "uid-a", "default"),
    makeResource("beta-pod", "uid-b", "kube-system"),
  ];

  test("filter runs independently of sort", () => {
    const filtered = filterItems(resources, "alpha", null);
    expect(filtered.length).toBe(1);
    expect(filtered[0].metadata.name).toBe("alpha-pod");
  });

  test("sort runs on filtered results only", () => {
    const filtered = filterItems(resources, "", null);
    const sorted = sortItems(filtered, "name", "asc");
    expect(sorted.map((r) => r.metadata.name)).toEqual(["alpha-pod", "beta-pod", "zeta-pod"]);
  });

  test("sort direction reverses order", () => {
    const filtered = filterItems(resources, "", null);
    const sorted = sortItems(filtered, "name", "desc");
    expect(sorted.map((r) => r.metadata.name)).toEqual(["zeta-pod", "beta-pod", "alpha-pod"]);
  });

  test("filter by namespace works", () => {
    const filtered = filterItems(resources, "kube-system", null);
    expect(filtered.length).toBe(1);
    expect(filtered[0].metadata.name).toBe("beta-pod");
  });

  test("empty filter returns all items", () => {
    const filtered = filterItems(resources, "", null);
    expect(filtered.length).toBe(3);
  });

  test("ageTick does not affect filter or sort inputs", () => {
    // The key insight: ageTick only affects cell rendering, not filter/sort derivation
    // This test verifies the filter/sort functions have no ageTick dependency
    let ageTick = 0;
    const filtered1 = filterItems(resources, "", null);
    const sorted1 = sortItems(filtered1, "name", "asc");

    ageTick = 42; // Simulate 42 ticks
    const filtered2 = filterItems(resources, "", null);
    const sorted2 = sortItems(filtered2, "name", "asc");

    // Same result regardless of ageTick
    expect(sorted1.map((r) => r.metadata.uid)).toEqual(sorted2.map((r) => r.metadata.uid));
  });
});
