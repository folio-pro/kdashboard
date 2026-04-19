import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource, ResourceList, ConnectionStatus, PortForwardInfo } from "../types/index.js";
import { K8sStoreLogic, type WatchEvent } from "./k8s.logic.js";

function makeResource(overrides: Partial<Resource> & { metadata: Partial<Resource["metadata"]> }): Resource {
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
      expect(store.connectionStatus).toBe("disconnected");
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
      expect(store.connectionStatus).toBe("disconnected");
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
      expect(store.connectionStatus).toBe("disconnected");
      expect(store.error).toBeNull();
      expect(store.resourceCounts).toEqual({});
    });
  });
});
