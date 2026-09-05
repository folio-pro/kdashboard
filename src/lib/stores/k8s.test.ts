import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource, ResourceList, ConnectionStatus, PortForwardInfo } from "../types/index.js";
import {
  K8sStoreLogic,
  crdTypeFor,
  parseCrdType,
  isNetworkErrorMessage,
  isWatchNotice,
  formatClock,
  type WatchEvent,
  type WatchNotice,
} from "./k8s.logic.js";

interface ResourceOverrides {
  kind?: string;
  api_version?: string;
  metadata: Partial<Resource["metadata"]>;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

function makeResource(overrides: ResourceOverrides): Resource {
  return {
    kind: overrides.kind ?? "Pod",
    api_version: overrides.api_version ?? "v1",
    metadata: {
      name: overrides.metadata.name ?? "test-pod",
      namespace: overrides.metadata.namespace ?? "default",
      uid: overrides.metadata.uid ?? `uid-${Math.random().toString(36).slice(2)}`,
      creation_timestamp: overrides.metadata.creation_timestamp ?? "2024-01-01T00:00:00Z",
      labels: overrides.metadata.labels ?? {},
      annotations: overrides.metadata.annotations ?? {},
      owner_references: overrides.metadata.owner_references ?? [],
      resource_version: overrides.metadata.resource_version ?? "1",
    },
    spec: overrides.spec ?? {},
    status: overrides.status ?? {},
  };
}

describe("K8sStore", () => {
  let store: K8sStoreLogic;

  beforeEach(() => {
    store = new K8sStoreLogic();
  });

  describe("initial state", () => {
    test("has default values", () => {
      expect(store.contexts).toEqual([]);
      expect(store.currentContext).toBe("");
      expect(store.currentNamespace).toBe("default");
      expect(store.selectedResourceType).toBe("pods");
      expect(store.connectionStatus as ConnectionStatus).toBe("disconnected");
      expect(store.isSwitchingContext).toBe(false);
      expect(store.isLoading).toBe(false);
      expect(store.error).toBeNull();
      expect(store.portForwards).toEqual([]);
      expect(store.hasNavHistory).toBe(false);
    });
  });

  describe("selectResource", () => {
    test("sets selectedResource", () => {
      const resource = makeResource({ metadata: { name: "my-pod", uid: "uid-1" } });
      store.selectResource(resource);
      expect(store.selectedResource).toBe(resource);
    });

    test("clears selectedResource with null", () => {
      const resource = makeResource({ metadata: { name: "my-pod", uid: "uid-1" } });
      store.selectResource(resource);
      store.selectResource(null);
      expect(store.selectedResource).toBeNull();
    });
  });

  describe("navigation history", () => {
    test("navigateToRelated pushes current to history", () => {
      const pod = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      const svc = makeResource({ kind: "Service", metadata: { name: "svc-1", uid: "uid-2" } });
      store.selectResource(pod);
      store.navigateToRelatedSync("services", svc);
      expect(store.hasNavHistory).toBe(true);
      expect(store.selectedResource).toBe(svc);
      expect(store.selectedResourceType).toBe("services");
    });

    test("navigateToRelated without selected resource does not push to history", () => {
      const svc = makeResource({ kind: "Service", metadata: { name: "svc-1", uid: "uid-2" } });
      store.navigateToRelatedSync("services", svc);
      expect(store.hasNavHistory).toBe(false);
    });

    test("navigateBack restores previous state", () => {
      const pod = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      const svc = makeResource({ kind: "Service", metadata: { name: "svc-1", uid: "uid-2" } });
      store.selectResource(pod);
      store.navigateToRelatedSync("services", svc);

      const result = store.navigateBack();
      expect(result).toBe(true);
      expect(store.selectedResource).toBe(pod);
      expect(store.selectedResourceType).toBe("pods");
    });

    test("navigateBack returns false when history is empty", () => {
      expect(store.navigateBack()).toBe(false);
    });

    test("multiple navigation levels", () => {
      const pod = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      const svc = makeResource({ kind: "Service", metadata: { name: "svc-1", uid: "uid-2" } });
      const deploy = makeResource({ kind: "Deployment", metadata: { name: "deploy-1", uid: "uid-3" } });

      store.selectResource(pod);
      store.navigateToRelatedSync("services", svc);
      store.navigateToRelatedSync("deployments", deploy);

      expect(store.navigateBack()).toBe(true);
      expect(store.selectedResource).toBe(svc);
      expect(store.navigateBack()).toBe(true);
      expect(store.selectedResource).toBe(pod);
      expect(store.navigateBack()).toBe(false);
    });

    test("clearNavHistory empties the stack", () => {
      const pod = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      const svc = makeResource({ kind: "Service", metadata: { name: "svc-1", uid: "uid-2" } });
      store.selectResource(pod);
      store.navigateToRelatedSync("services", svc);
      store.clearNavHistory();
      expect(store.hasNavHistory).toBe(false);
      expect(store.navigateBack()).toBe(false);
    });
  });

  describe("lastUpdatedAt", () => {
    test("_replaceResources stamps the list it swaps in", () => {
      const list: ResourceList = { items: [makeResource({ metadata: { name: "a", uid: "u1" } })], resource_type: "pods" };
      store._replaceResources(list, 1234);
      expect(store.resources).toBe(list);
      expect(store.lastUpdatedAt).toBe(1234);
    });

    test("watch deltas stamp the list", () => {
      store.resources = { items: [], resource_type: "pods" };
      store.handleWatchEvent({
        event_type: "Applied",
        resource_type: "pods",
        resource: makeResource({ metadata: { name: "a", uid: "u1" } }),
      });
      expect(store.lastUpdatedAt).toBeGreaterThan(0);
    });

    test("_resetVisibleState and a tab-cache restore forget the previous view's timestamp", () => {
      store._replaceResources({ items: [], resource_type: "pods" }, 1234);
      store._resetVisibleState();
      expect(store.lastUpdatedAt).toBe(0);

      store._replaceResources({ items: [], resource_type: "pods" }, 1234);
      store.restoreResourcesSync("deployments", []);
      expect(store.lastUpdatedAt).toBe(0);
    });
  });

  describe("_resetVisibleState", () => {
    test("clears errors and resources", () => {
      store.error = "some error";
      store.contextsLoadError = "ctx error";
      store.namespacesLoadError = "ns error";
      store.resources = { items: [makeResource({ metadata: { name: "x", uid: "u1" } })], resource_type: "pods" };
      store.selectedResource = makeResource({ metadata: { name: "x", uid: "u1" } });
      store.resourceCounts = { pods: 5 };

      store._resetVisibleState();

      expect(store.error).toBeNull();
      expect(store.contextsLoadError).toBeNull();
      expect(store.namespacesLoadError).toBeNull();
      expect(store.resources.items).toEqual([]);
      expect(store.selectedResource).toBeNull();
      expect(store.resourceCounts).toEqual({});
    });

    test("clearContexts resets context and connection", () => {
      store.contexts = ["ctx-1", "ctx-2"];
      store.currentContext = "ctx-1";
      store.connectionStatus = "connected";

      store._resetVisibleState({ clearContexts: true });

      expect(store.contexts).toEqual([]);
      expect(store.currentContext).toBe("");
      expect(store.connectionStatus as ConnectionStatus).toBe("disconnected");
    });

    test("clearNamespaces empties namespaces list", () => {
      store.namespaces = ["default", "kube-system"];
      store._resetVisibleState({ clearNamespaces: true });
      expect(store.namespaces).toEqual([]);
    });

    test("keepNamespace preserves specified namespace", () => {
      store.currentNamespace = "production";
      store._resetVisibleState({ keepNamespace: "staging" });
      expect(store.currentNamespace).toBe("staging");
    });

    test("without keepNamespace preserves current namespace", () => {
      store.currentNamespace = "production";
      store._resetVisibleState();
      expect(store.currentNamespace).toBe("production");
    });
  });

  describe("viewLoaded", () => {
    test("false initially (boot must show loading, not empty)", () => {
      expect(store.viewLoaded).toBe(false);
    });

    test("restoreResourcesSync marks the view loaded", () => {
      store.restoreResourcesSync("pods", []);
      expect(store.viewLoaded).toBe(true);
    });

    test("switching resource type resets it; same type keeps it", () => {
      store.restoreResourcesSync("pods", []);
      store.setResourceType("deployments");
      expect(store.viewLoaded).toBe(false);
      store.restoreResourcesSync("deployments", []);
      store.setResourceType("deployments");
      expect(store.viewLoaded).toBe(true);
    });

    test("_resetVisibleState resets it", () => {
      store.restoreResourcesSync("pods", []);
      store._resetVisibleState();
      expect(store.viewLoaded).toBe(false);
    });
  });

  describe("restoreNamespace", () => {
    test("adopts a candidate that exists in the cluster", () => {
      store.namespaces = ["default", "prod"];
      store.restoreNamespace("prod");
      expect(store.currentNamespace).toBe("prod");
    });

    test("trusts the candidate when no namespace list is loaded", () => {
      store.namespaces = [];
      store.restoreNamespace("prod");
      expect(store.currentNamespace).toBe("prod");
    });

    test("rejects empty candidate (cluster-scope listing) and keeps a valid current", () => {
      store.namespaces = ["default", "prod"];
      store.currentNamespace = "prod";
      store.restoreNamespace("");
      expect(store.currentNamespace).toBe("prod");
    });

    test("snaps an invalid current namespace to default", () => {
      store.namespaces = ["default", "prod"];
      store.currentNamespace = "gone-namespace";
      store.restoreNamespace();
      expect(store.currentNamespace).toBe("default");
    });

    test("snaps to the first namespace when default is absent", () => {
      store.namespaces = ["alpha", "beta"];
      store.currentNamespace = "gone-namespace";
      store.restoreNamespace("also-gone");
      expect(store.currentNamespace).toBe("alpha");
    });
  });

  describe("_beginScopeChange", () => {
    test("increments scope and count generations", () => {
      const gen1 = store._beginScopeChange();
      const gen2 = store._beginScopeChange();
      expect(gen2).toBe(gen1 + 1);
    });
  });

  describe("_setCount", () => {
    test("sets resource count", () => {
      store._setCount("pods", 5);
      expect(store.resourceCounts["pods"]).toBe(5);
    });

    test("skips update if count unchanged", () => {
      store._setCount("pods", 5);
      const ref1 = store.resourceCounts;
      store._setCount("pods", 5);
      expect(store.resourceCounts).toBe(ref1); // same reference = no reactive update
    });

    test("updates when count changes", () => {
      store._setCount("pods", 5);
      const ref1 = store.resourceCounts;
      store._setCount("pods", 6);
      expect(store.resourceCounts).not.toBe(ref1); // new reference
      expect(store.resourceCounts["pods"]).toBe(6);
    });

    test("preserves other counts", () => {
      store._setCount("pods", 3);
      store._setCount("services", 2);
      expect(store.resourceCounts["pods"]).toBe(3);
      expect(store.resourceCounts["services"]).toBe(2);
    });
  });

  describe("handleWatchEvent", () => {
    test("ignores events for different resource types", () => {
      store.selectedResourceType = "pods";
      const resource = makeResource({ metadata: { name: "svc-1", uid: "uid-1" } });
      store.handleWatchEvent({
        event_type: "Applied",
        resource_type: "services",
        resource,
      });
      expect(store.resources.items).toEqual([]);
    });

    test("Applied event adds new resource", () => {
      store.selectedResourceType = "pods";
      const resource = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      store.handleWatchEvent({
        event_type: "Applied",
        resource_type: "pods",
        resource,
      });
      expect(store.resources.items.length).toBe(1);
      expect(store.resources.items[0].metadata.name).toBe("pod-1");
      expect(store.resourceCounts["pods"]).toBe(1);
    });

    test("Applied event updates existing resource", () => {
      store.selectedResourceType = "pods";
      const resource = makeResource({
        metadata: { name: "pod-1", uid: "uid-1" },
        status: { phase: "Running" },
      });
      store.resources = { items: [resource], resource_type: "pods" };

      const updated = makeResource({
        metadata: { name: "pod-1", uid: "uid-1" },
        status: { phase: "Succeeded" },
      });
      store.handleWatchEvent({
        event_type: "Applied",
        resource_type: "pods",
        resource: updated,
      });

      expect(store.resources.items.length).toBe(1);
      expect(store.resources.items[0].status).toEqual({ phase: "Succeeded" });
    });

    test("Applied event updates selectedResource if matching", () => {
      store.selectedResourceType = "pods";
      const resource = makeResource({
        metadata: { name: "pod-1", uid: "uid-1" },
        status: { phase: "Running" },
      });
      store.resources = { items: [resource], resource_type: "pods" };
      store.selectedResource = resource;

      const updated = makeResource({
        metadata: { name: "pod-1", uid: "uid-1" },
        status: { phase: "Succeeded" },
      });
      store.handleWatchEvent({
        event_type: "Applied",
        resource_type: "pods",
        resource: updated,
      });

      expect(store.selectedResource?.status).toEqual({ phase: "Succeeded" });
    });

    test("Deleted event removes resource", () => {
      store.selectedResourceType = "pods";
      const r1 = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      const r2 = makeResource({ metadata: { name: "pod-2", uid: "uid-2" } });
      store.resources = { items: [r1, r2], resource_type: "pods" };
      store._setCount("pods", 2);

      store.handleWatchEvent({
        event_type: "Deleted",
        resource_type: "pods",
        resource: r1,
      });

      expect(store.resources.items.length).toBe(1);
      expect(store.resources.items[0].metadata.uid).toBe("uid-2");
      expect(store.resourceCounts["pods"]).toBe(1);
    });

    test("Deleted event clears selectedResource if matching", () => {
      store.selectedResourceType = "pods";
      const resource = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      store.resources = { items: [resource], resource_type: "pods" };
      store.selectedResource = resource;

      store.handleWatchEvent({
        event_type: "Deleted",
        resource_type: "pods",
        resource,
      });

      expect(store.selectedResource).toBeNull();
    });

    test("Deleted event for non-existent resource is a no-op", () => {
      store.selectedResourceType = "pods";
      const existing = makeResource({ metadata: { name: "pod-1", uid: "uid-1" } });
      store.resources = { items: [existing], resource_type: "pods" };

      const nonExistent = makeResource({ metadata: { name: "pod-2", uid: "uid-2" } });
      store.handleWatchEvent({
        event_type: "Deleted",
        resource_type: "pods",
        resource: nonExistent,
      });

      expect(store.resources.items.length).toBe(1);
    });

    test("ignores event without uid", () => {
      store.selectedResourceType = "pods";
      const resource = makeResource({ metadata: { name: "pod-1", uid: "" } });
      // @ts-ignore - testing edge case
      resource.metadata.uid = undefined as any;
      store.handleWatchEvent({
        event_type: "Applied",
        resource_type: "pods",
        resource,
      });
      expect(store.resources.items).toEqual([]);
    });
  });

  describe("port forwards", () => {
    test("addPortForwardSync adds to list", () => {
      const pf: PortForwardInfo = {
        session_id: "sess-1",
        pod_name: "pod-1",
        namespace: "default",
        container_port: 8080,
        local_port: 9090,
      };
      store.addPortForwardSync(pf);
      expect(store.portForwards.length).toBe(1);
      expect(store.portForwards[0].session_id).toBe("sess-1");
    });

    test("removePortForwardSync removes by session id", () => {
      const pf1: PortForwardInfo = {
        session_id: "sess-1",
        pod_name: "pod-1",
        namespace: "default",
        container_port: 8080,
        local_port: 9090,
      };
      const pf2: PortForwardInfo = {
        session_id: "sess-2",
        pod_name: "pod-2",
        namespace: "default",
        container_port: 3000,
        local_port: 3001,
      };
      store.addPortForwardSync(pf1);
      store.addPortForwardSync(pf2);
      store.removePortForwardSync("sess-1");
      expect(store.portForwards.length).toBe(1);
      expect(store.portForwards[0].session_id).toBe("sess-2");
    });

    test("removePortForwardSync with unknown session is a no-op", () => {
      const pf: PortForwardInfo = {
        session_id: "sess-1",
        pod_name: "pod-1",
        namespace: "default",
        container_port: 8080,
        local_port: 9090,
      };
      store.addPortForwardSync(pf);
      store.removePortForwardSync("unknown");
      expect(store.portForwards.length).toBe(1);
    });
  });

  describe("resetForUserSwitch", () => {
    test("resets everything to initial state", () => {
      store.contexts = ["ctx-1"];
      store.currentContext = "ctx-1";
      store.namespaces = ["default", "prod"];
      store.currentNamespace = "prod";
      store.connectionStatus = "connected";
      store.isSwitchingContext = true;
      store.switchingContextTo = "ctx-2";
      store.selectedResourceType = "services";
      store.error = "some error";

      store.resetForUserSwitchSync();

      expect(store.isSwitchingContext).toBe(false);
      expect(store.switchingContextTo).toBeNull();
      expect(store.selectedResourceType).toBe("pods");
      expect(store.contexts).toEqual([]);
      expect(store.currentContext).toBe("");
      expect(store.namespaces).toEqual([]);
      expect(store.currentNamespace).toBe("default");
      expect(store.connectionStatus as ConnectionStatus).toBe("disconnected");
      expect(store.error).toBeNull();
      expect(store.resourceCounts).toEqual({});
    });
  });
});

describe("reachability", () => {
  let store: K8sStoreLogic;
  beforeEach(() => {
    store = new K8sStoreLogic();
  });

  test("starts reachable with no heartbeat", () => {
    expect(store.reachable).toBe(true);
    expect(store.unreachableSince).toBe(0);
    expect(store.lastHeartbeatAt).toBe(0);
    expect(store.unreachableTooltip).toBe("");
  });

  test("a transport failure starts an outage; the cluster answering ends it", () => {
    expect(store.noteCallFailure("Cannot reach the cluster apiserver at https://127.0.0.1:6443: connection refused [ECONNREFUSED]", 1_000)).toBe(true);
    expect(store.reachable).toBe(false);
    expect(store.unreachableSince).toBe(1_000);
    // A second failure keeps the ORIGINAL start of the outage.
    store.noteCallFailure("fetch failed", 2_000);
    expect(store.unreachableSince).toBe(1_000);

    expect(store._markReachable(3_000)).toBe(true);
    expect(store.reachable).toBe(true);
    expect(store.unreachableSince).toBe(0);
    expect(store.lastHeartbeatAt).toBe(3_000);
    // Already reachable: a heartbeat, not a recovery.
    expect(store._markReachable(4_000)).toBe(false);
    expect(store.lastHeartbeatAt).toBe(4_000);
  });

  test("a failure the cluster itself answered is not an outage", () => {
    expect(store.noteCallFailure('pods is forbidden: User "x" cannot list resource "pods"')).toBe(false);
    expect(store.noteCallFailure("Unknown resource type: crd:demo.kdash.io/Widget")).toBe(false);
    expect(store.noteCallFailure('secrets "foo" not found')).toBe(false);
    expect(store.reachable).toBe(true);
  });

  test("tooltip names when the outage began and how old the data is", () => {
    const since = new Date(2026, 0, 1, 9, 5).getTime();
    const dataAt = new Date(2026, 0, 1, 8, 59).getTime();
    store._replaceResources({ items: [], resource_type: "pods" }, dataAt);
    store._markUnreachable(since);
    expect(store.unreachableTooltip).toBe("Cluster unreachable since 09:05 · showing data from 08:59");

    // No list ever landed: fall back to the last heartbeat, then to nothing.
    const bare = new K8sStoreLogic();
    bare._markReachable(dataAt);
    bare._markUnreachable(since);
    expect(bare.unreachableTooltip).toBe("Cluster unreachable since 09:05 · showing data from 08:59");
    const never = new K8sStoreLogic();
    never._markUnreachable(since);
    expect(never.unreachableTooltip).toBe("Cluster unreachable since 09:05");
  });
});

describe("isNetworkErrorMessage", () => {
  test("matches the shapes the backend produces for transport failures", () => {
    for (const msg of [
      "Cannot reach the cluster apiserver at https://x: connection refused — nothing is listening there [ECONNREFUSED]",
      "Request to https://x failed: connect ETIMEDOUT",
      "getaddrinfo EAI_AGAIN api.example.com",
      "fetch failed",
      "socket hang up",
      "HTTP-Code: 503\nMessage: the server is currently unable to handle the request",
      "Service Unavailable",
      "Bad Gateway",
      "read ECONNRESET",
    ]) {
      expect(isNetworkErrorMessage(msg), msg).toBe(true);
    }
  });

  test("leaves errors the cluster answered alone", () => {
    for (const msg of [
      'pods is forbidden: User "x" cannot list resource "pods" in API group ""',
      'deployments.apps "web" not found',
      "Unknown resource type for watch: crd:demo.kdash.io/Widget",
      "watch cancelled before it finished opening",
      "Invalid value: -1: must be greater than or equal to 0",
    ]) {
      expect(isNetworkErrorMessage(msg), msg).toBe(false);
    }
  });
});

describe("formatClock", () => {
  test("renders local HH:MM, zero-padded", () => {
    expect(formatClock(new Date(2026, 5, 3, 7, 4).getTime())).toBe("07:04");
    expect(formatClock(new Date(2026, 5, 3, 23, 59).getTime())).toBe("23:59");
  });
});

describe("watch notices", () => {
  let store: K8sStoreLogic;
  beforeEach(() => {
    store = new K8sStoreLogic();
    store.setResourceType("pods");
    store.watching = true;
  });

  test("isWatchNotice tells notices from deltas", () => {
    expect(isWatchNotice({ event_type: "watch_error", resource_type: "pods" })).toBe(true);
    expect(isWatchNotice({ event_type: "watch_open", resource_type: "pods" })).toBe(true);
    expect(isWatchNotice({ event_type: "Applied", resource_type: "pods", resource: makeResource({ metadata: {} }) })).toBe(false);
  });

  test("watch_error stops 'Watching' and, when transport-level, starts an outage", () => {
    const notice: WatchNotice = { event_type: "watch_error", resource_type: "pods", message: "Cannot reach the cluster apiserver at https://x: connection refused [ECONNREFUSED]" };
    store.handleWatchNotice(notice, 500);
    expect(store.watching).toBe(false);
    expect(store.reachable).toBe(false);
    expect(store.unreachableSince).toBe(500);
  });

  test("a watch_error the apiserver answered is not an outage — just not watching", () => {
    store.handleWatchNotice({ event_type: "watch_error", resource_type: "pods", message: "Premature close" });
    expect(store.watching).toBe(false);
    expect(store.reachable).toBe(true);
  });

  test("watch_open restores watching and counts as a heartbeat", () => {
    store.handleWatchNotice({ event_type: "watch_error", resource_type: "pods", message: "fetch failed" }, 10);
    store.handleWatchNotice({ event_type: "watch_open", resource_type: "pods" }, 20);
    expect(store.watching).toBe(true);
    expect(store.reachable).toBe(true);
    expect(store.lastHeartbeatAt).toBe(20);
  });

  test("notices for another type are ignored, and handleWatchEvent routes them", () => {
    store.handleWatchEvent({ event_type: "watch_error", resource_type: "deployments", message: "fetch failed" });
    expect(store.watching).toBe(true);
    expect(store.reachable).toBe(true);
    store.handleWatchEvent({ event_type: "watch_error", resource_type: "pods", message: "fetch failed" });
    expect(store.watching).toBe(false);
    expect(store.reachable).toBe(false);
  });
});

describe("CRD pseudo-types", () => {
  const widget = { group: "demo.kdash.io", version: "v1", kind: "Widget", plural: "widgets", scope: "Namespaced" as const, short_names: [] };
  const gadget = { ...widget, kind: "Gadget", plural: "gadgets", scope: "Cluster" as const };

  test("crdTypeFor / parseCrdType round-trip, and reject non-CRD types", () => {
    expect(crdTypeFor(widget)).toBe("crd:demo.kdash.io/Widget");
    expect(parseCrdType("crd:demo.kdash.io/Widget")).toEqual({ group: "demo.kdash.io", kind: "Widget" });
    expect(parseCrdType("pods")).toBeNull();
    expect(parseCrdType("crd:broken")).toBeNull();
  });

  test("findCrd reads discovery groups, or the selected CRD before discovery", () => {
    const store = new K8sStoreLogic();
    expect(store.findCrd("demo.kdash.io", "Widget")).toBeNull();
    store.selectedCrd = widget;
    expect(store.findCrd("demo.kdash.io", "Widget")).toBe(widget);
    store.selectedCrd = null;
    store.crdGroups = [{ group: "demo.kdash.io", resources: [widget, gadget] }];
    expect(store.findCrd("demo.kdash.io", "Gadget")).toBe(gadget);
    expect(store.findCrd("other.io", "Gadget")).toBeNull();
    expect(store.isClusterScopedCrd("crd:demo.kdash.io/Gadget")).toBe(true);
    expect(store.isClusterScopedCrd("crd:demo.kdash.io/Widget")).toBe(false);
    expect(store.isClusterScopedCrd("nodes")).toBe(false);
  });

  test("a CRD listing's rows follow every writer of `resources` — including watch deltas", () => {
    const store = new K8sStoreLogic();
    const type = crdTypeFor(widget);
    store.crdGroups = [{ group: "demo.kdash.io", resources: [widget] }];
    store.setResourceType(type);
    const a = makeResource({ kind: "Widget", metadata: { name: "a", uid: "w-a" } });
    const columns = [{ name: "Phase", json_path: ".status.phase", column_type: "string", description: "" }];
    store._adoptCrdListing(type, [a], columns);
    store._replaceResources({ items: [a], resource_type: type }, 1);
    expect(store.crdResources.items).toEqual([a]);
    expect(store.crdResources.columns).toBe(columns);

    const b = makeResource({ kind: "Widget", metadata: { name: "b", uid: "w-b" } });
    store.handleWatchEvent({ event_type: "Applied", resource_type: type, resource: b });
    expect(store.crdResources.items.map((r) => r.metadata.name)).toEqual(["a", "b"]);
    expect(store.crdResources.columns).toBe(columns);

    store.handleWatchEvent({ event_type: "Deleted", resource_type: type, resource: a });
    expect(store.crdResources.items.map((r) => r.metadata.name)).toEqual(["b"]);

    // A built-in listing never touches the CRD view.
    store.setResourceType("pods");
    store._replaceResources({ items: [makeResource({ metadata: { uid: "p" } })], resource_type: "pods" }, 2);
    expect(store.crdResources.items.map((r) => r.metadata.name)).toEqual(["b"]);
  });

  test("restoring a CRD tab from cache brings back its columns and selection", () => {
    const store = new K8sStoreLogic();
    const type = crdTypeFor(widget);
    store.crdGroups = [{ group: "demo.kdash.io", resources: [widget, gadget] }];
    const columns = [{ name: "Phase", json_path: ".status.phase", column_type: "string", description: "" }];
    store._adoptCrdListing(type, [], columns);

    store.selectedCrd = gadget;
    const a = makeResource({ kind: "Widget", metadata: { name: "a", uid: "w-a" } });
    store.restoreResourcesSync(type, [a]);
    expect(store.selectedCrd).toBe(widget);
    expect(store.crdResources).toEqual({ items: [a], columns });
    expect(store.resources.items).toBe(store.crdResources.items);
  });
});

describe("restoreNamespace and 'all namespaces'", () => {
  test('a restored "" never becomes cluster scope on its own; a loaded list snaps it to a real namespace', () => {
    const store = new K8sStoreLogic();
    store.namespaces = ["kube-system", "team-a"];
    store.currentNamespace = "";
    store.restoreNamespace("");
    expect(store.currentNamespace).toBe("kube-system");
  });

  test('an explicit "" (All namespaces) survives as the current namespace', () => {
    const store = new K8sStoreLogic();
    store.namespaces = ["default", "team-a"];
    store.currentNamespace = "";
    store._resetVisibleState({ keepNamespace: "" });
    expect(store.currentNamespace).toBe("");
  });
});
