import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource } from "../types/index.js";
import { K8sStoreLogic, type WatchEvent } from "./k8s.logic.js";
import { FakeKubeIo } from "./k8s.io.fake.js";

function mkResource(name: string, namespace = "default"): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid: `uid-${name}`,
      creation_timestamp: "2024-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: {},
  };
}

function applied(r: Resource): WatchEvent {
  return { event_type: "Applied", resource_type: "pods", resource: r };
}
function deleted(r: Resource): WatchEvent {
  return { event_type: "Deleted", resource_type: "pods", resource: r };
}

/** Drain microtasks + timers so the base's queueMicrotask flush runs. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * These exercise the load → cache → watch → reconcile orchestration that used
 * to live in the Tauri-coupled Svelte subclass — the exact code the
 * stale-on-return bug lived in, and which had no test seam. With KubeIo
 * extracted, the FakeKubeIo adapter drives the real state machine in bun.
 */
describe("K8sStoreLogic orchestration (via FakeKubeIo)", () => {
  let io: FakeKubeIo;
  let store: K8sStoreLogic;

  beforeEach(() => {
    io = new FakeKubeIo();
    store = new K8sStoreLogic(io);
  });

  describe("loadResources", () => {
    test("populates items, selects the type, and starts a watch", async () => {
      io.setList([mkResource("a"), mkResource("b")], "pods");

      await store.loadResources("pods");
      await tick();

      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a", "b"]);
      expect(store.selectedResourceType).toBe("pods");
      expect(store.error).toBeNull();
      expect(io.watchStarted).toEqual({ resourceType: "pods", namespace: "default" });
    });

    test("stamps resource_type even though the backend omits it", async () => {
      // The Rust ResourceList carries only `items` — resource_type arrives
      // undefined. The store must stamp it, or saveOutgoingTabState's cache
      // guard (resources.resource_type === tab.resourceType) silently fails.
      io.listResult = { items: [mkResource("a")], resource_type: undefined as unknown as string };

      await store.loadResources("pods");

      expect(store.resources.resource_type).toBe("pods");
    });

    test("on list failure sets error and blanks the table", async () => {
      io.listError = new Error("boom");

      await store.loadResources("pods");

      expect(store.error).toContain("Failed to load resources");
      expect(store.resources.items).toEqual([]);
    });
  });

  describe("reconcileResources — the stale-on-return fix, at the real layer", () => {
    test("reconciles rows that changed while the tab was inactive", async () => {
      // Tab was active on [a]; watch started (initial list suppressed by backend).
      io.setList([mkResource("a")], "pods");
      await store.loadResources("pods");
      await tick();
      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a"]);

      // While away, the cluster gains pod b. The fresh watcher on return will
      // NOT replay it — only a refetch can reconcile.
      io.setList([mkResource("a"), mkResource("b")], "pods");

      // Return: paint the cached (stale) snapshot instantly...
      store.restoreResources("pods", [mkResource("a")]);
      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a"]);

      // ...then reconcile in the background.
      await store.reconcileResources("pods");
      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a", "b"]);
    });

    test("reconcile keeps resource_type stamped (does not clobber to undefined)", async () => {
      io.setList([mkResource("a")], "pods");
      await store.loadResources("pods");
      await tick();

      // Backend omits resource_type on the reconcile fetch too.
      io.listResult = { items: [mkResource("a")], resource_type: undefined as unknown as string };
      await store.reconcileResources("pods");

      // Must stay "pods" so the next saveOutgoingTabState cache guard passes.
      expect(store.resources.resource_type).toBe("pods");
    });

    test("keeps the cached snapshot when the reconcile fetch fails", async () => {
      io.setList([mkResource("a")], "pods");
      await store.loadResources("pods");
      await tick();

      store.restoreResources("pods", [mkResource("a")]);
      io.listError = new Error("transient");

      await store.reconcileResources("pods");

      // Must NOT blank the table on a transient failure.
      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a"]);
    });

    test("discards the reconcile result if the type drifted mid-flight", async () => {
      io.setList([mkResource("a")], "pods");
      await store.loadResources("pods");
      await tick();

      // Simulate the user switching type before the reconcile resolves.
      io.setList([mkResource("stale")], "pods");
      store.setResourceType("services");

      await store.reconcileResources("pods");

      // The pods result must not overwrite the now-services view.
      expect(store.resources.items.map((r) => r.metadata.name)).not.toContain("stale");
    });
  });

  describe("watch flush (the shipping batched Map-upsert path)", () => {
    beforeEach(async () => {
      io.setList([mkResource("a")], "pods");
      await store.loadResources("pods");
      await tick();
    });

    test("coalesces a batch of Applied/Deleted into one update", async () => {
      store["_handleWatchEvents"]([applied(mkResource("b")), applied(mkResource("c"))]);
      await tick();

      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a", "b", "c"]);
    });

    test("Deleted removes the row", async () => {
      store["_handleWatchEvents"](deleted(mkResource("a")));
      await tick();

      expect(store.resources.items).toEqual([]);
    });

    test("ignores events for a different resource type", async () => {
      store["_handleWatchEvents"]({
        event_type: "Applied",
        resource_type: "services",
        resource: mkResource("svc"),
      });
      await tick();

      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a"]);
    });

    test("Resync triggers a full refetch (previously stubbed, now real)", async () => {
      io.setList([mkResource("a"), mkResource("b"), mkResource("c")], "pods");
      store["_handleWatchEvents"]({
        event_type: "Resync",
        resource_type: "pods",
        resource: mkResource("ignored"),
      });
      await tick();

      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a", "b", "c"]);
    });

    test("Applied updates an existing row in place", async () => {
      const updated = { ...mkResource("a"), status: { phase: "Succeeded" } };
      store["_handleWatchEvents"](applied(updated));
      await tick();

      expect(store.resources.items).toHaveLength(1);
      expect(store.resources.items[0].status).toEqual({ phase: "Succeeded" });
    });

    test("Applied to the selected resource updates selectedResource", async () => {
      store.selectedResource = store.resources.items[0];
      const updated = { ...mkResource("a"), status: { phase: "Succeeded" } };
      store["_handleWatchEvents"](applied(updated));
      await tick();

      expect(store.selectedResource?.status).toEqual({ phase: "Succeeded" });
    });

    test("Deleting the selected resource clears selectedResource", async () => {
      store.selectedResource = store.resources.items[0];
      store["_handleWatchEvents"](deleted(mkResource("a")));
      await tick();

      expect(store.selectedResource).toBeNull();
    });

    test("Deleting a non-existent row is a no-op", async () => {
      store["_handleWatchEvents"](deleted(mkResource("ghost")));
      await tick();

      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a"]);
    });

    test("ignores an event whose resource has no uid", async () => {
      const noUid = mkResource("x");
      (noUid.metadata as { uid?: string }).uid = undefined;
      store["_handleWatchEvents"](applied(noUid));
      await tick();

      expect(store.resources.items.map((r) => r.metadata.name)).toEqual(["a"]);
    });
  });
});
