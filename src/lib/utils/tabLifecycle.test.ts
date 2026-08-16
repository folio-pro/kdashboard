import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { Resource, ResourceList } from "$lib/types";
import type { Tab } from "$lib/stores/ui.logic";
import { CachedItems } from "$lib/stores/ui.logic";
import { handleTabSwitch, type TabLifecycleK8sStore } from "./tabLifecycle";

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

function mkTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    type: "table",
    label: "Resources",
    closable: true,
    ...overrides,
  };
}

function mkStore(overrides: Partial<TabLifecycleK8sStore> = {}): TabLifecycleK8sStore {
  const base: TabLifecycleK8sStore = {
    selectedResource: null,
    resources: { items: [], resource_type: "" },
    currentNamespace: "default",
    selectedResourceType: "pods",
    isLoading: false,
    error: null,
    selectResource(resource) {
      this.selectedResource = resource;
    },
    setResourceType: () => {},
    restoreResources: () => {},
    switchNamespace: async () => {},
    loadResources: async () => {},
    resolveResourceByRef: async () => null,
  };
  return { ...base, ...overrides };
}

describe("handleTabSwitch", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
  });

  // --- Outgoing tab state ---

  test("saves selected resource on outgoing resource tab", () => {
    const fromTab = mkTab({ id: "from", type: "details" });
    const toTab = mkTab({ id: "to", type: "settings" });
    const resource = mkResource("pod-a");
    const k8s = mkStore({ selectedResource: resource });

    handleTabSwitch(fromTab, toTab, k8s);

    expect(fromTab.cachedResource).toBe(resource);
  });

  test("saves items on outgoing table tab when resource_type matches", () => {
    const items = [mkResource("a"), mkResource("b")];
    const fromTab = mkTab({ id: "from", type: "table", resourceType: "pods" });
    const toTab = mkTab({ id: "to", type: "settings" });
    const k8s = mkStore({ resources: { items, resource_type: "pods" } });

    handleTabSwitch(fromTab, toTab, k8s);

    expect(fromTab.cachedItems?.items).toBe(items);
    expect(fromTab.count).toBe(2);
    expect(fromTab.cacheReady).toBe(true);
  });

  test("skips save when store holds a different resource_type (in-flight)", () => {
    const fromTab = mkTab({ id: "from", type: "table", resourceType: "pods" });
    const toTab = mkTab({ id: "to", type: "settings" });
    const k8s = mkStore({
      resources: { items: [mkResource("wrong")], resource_type: "services" },
    });

    handleTabSwitch(fromTab, toTab, k8s);

    expect(fromTab.cachedItems).toBeUndefined();
    expect(fromTab.cacheReady).toBeUndefined();
  });

  // --- Incoming tab restoration ---

  test("restores cachedResource onto store for incoming detail tab", () => {
    const fromTab = mkTab({ id: "from", type: "settings" });
    const cached = mkResource("pod-b");
    const toTab = mkTab({ id: "to", type: "details", cachedResource: cached });
    const k8s = mkStore();

    handleTabSwitch(fromTab, toTab, k8s);

    expect(k8s.selectedResource).toBe(cached);
  });

  // --- Cache hit path ---

  test("restores from cache synchronously when cacheReady", () => {
    const cachedItems = [mkResource("a")];
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "kube-system",
      cachedItems: new CachedItems(cachedItems),
      cacheReady: true,
    });
    const restoreResources = mock((_type: string, _items: Resource[]) => {
      calls.push("restoreResources");
    });
    const k8s = mkStore({
      currentNamespace: "default",
      restoreResources,
      switchNamespace: async () => {
        calls.push("switchNamespace");
      },
      loadResources: async () => {
        calls.push("loadResources");
      },
    });

    handleTabSwitch(undefined, toTab, k8s);

    expect(k8s.currentNamespace).toBe("kube-system");
    expect(restoreResources).toHaveBeenCalledWith("pods", cachedItems);
    expect(calls).toEqual(["restoreResources"]);
  });

  test("cache hit with matching namespace does not mutate currentNamespace", () => {
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "default",
      cachedItems: new CachedItems([]),
      cacheReady: true,
    });
    const k8s = mkStore({ currentNamespace: "default" });
    const nsBefore = k8s.currentNamespace;

    handleTabSwitch(undefined, toTab, k8s);

    expect(k8s.currentNamespace).toBe(nsBefore);
  });

  // --- Cache miss / load path ---

  test("cache miss triggers switchNamespace when namespace differs", async () => {
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "kube-system",
    });
    const setResourceType = mock((_type: string) => {});
    const switchNamespace = mock(async (_ns: string) => {});
    const loadResources = mock(async (_type: string) => {});
    const k8s = mkStore({
      currentNamespace: "default",
      setResourceType,
      switchNamespace,
      loadResources,
    });

    handleTabSwitch(undefined, toTab, k8s);
    await new Promise((r) => setTimeout(r, 0));

    expect(setResourceType).toHaveBeenCalledWith("pods");
    expect(switchNamespace).toHaveBeenCalledWith("kube-system");
    expect(loadResources).not.toHaveBeenCalled();
  });

  test("cache miss without namespace diff triggers loadResources", async () => {
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "default",
    });
    const loadResources = mock(async (_type: string) => {});
    const switchNamespace = mock(async (_ns: string) => {});
    const k8s = mkStore({
      currentNamespace: "default",
      loadResources,
      switchNamespace,
    });

    handleTabSwitch(undefined, toTab, k8s);
    await new Promise((r) => setTimeout(r, 0));

    expect(loadResources).toHaveBeenCalledWith("pods");
    expect(switchNamespace).not.toHaveBeenCalled();
    // Sync side effects before the fetch resolves.
    expect(k8s.isLoading).toBe(true);
    expect(k8s.resources.resource_type).toBe("pods");
  });

  test("populates cache after successful load", async () => {
    const loaded = [mkResource("fresh-a"), mkResource("fresh-b")];
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "default",
    });
    const k8s = mkStore({
      currentNamespace: "default",
      loadResources: async () => {
        k8s.resources = { items: loaded, resource_type: "pods" };
        k8s.selectedResourceType = "pods";
      },
    });

    handleTabSwitch(undefined, toTab, k8s);
    // Wait for the microtask chain (loadResources -> then).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(toTab.cachedItems?.items).toBe(loaded);
    expect(toTab.count).toBe(2);
    expect(toTab.cacheReady).toBe(true);
  });

  test("skips cache population when resourceType drifted (race guard)", async () => {
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "default",
    });
    const k8s = mkStore({
      currentNamespace: "default",
      loadResources: async () => {
        // Simulate user switching to a different type before load completed.
        k8s.selectedResourceType = "services";
        k8s.resources = { items: [mkResource("svc")], resource_type: "services" };
      },
    });

    handleTabSwitch(undefined, toTab, k8s);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(toTab.cachedItems).toBeUndefined();
    expect(toTab.cacheReady).toBe(false);
  });

  test("skips cache population when store reported error", async () => {
    const toTab = mkTab({
      id: "to",
      type: "table",
      resourceType: "pods",
      namespace: "default",
    });
    const k8s = mkStore({
      currentNamespace: "default",
      loadResources: async () => {
        k8s.selectedResourceType = "pods";
        k8s.error = "boom";
      },
    });

    handleTabSwitch(undefined, toTab, k8s);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(toTab.cacheReady).toBe(false);
    expect(toTab.cachedItems).toBeUndefined();
  });

  test("rejected load does not throw unhandled", async () => {
    const original = console.error;
    const errSpy = mock((..._args: unknown[]) => {});
    console.error = errSpy;
    try {
      const toTab = mkTab({
        id: "to",
        type: "table",
        resourceType: "pods",
        namespace: "default",
      });
      const k8s = mkStore({
        currentNamespace: "default",
        loadResources: async () => {
          throw new Error("nope");
        },
      });

      handleTabSwitch(undefined, toTab, k8s);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(errSpy).toHaveBeenCalled();
      expect(toTab.cacheReady).toBe(false);
    } finally {
      console.error = original;
    }
  });

  // --- No-op branches ---

  test("non-table incoming tab with no resourceType does nothing to store", () => {
    const toTab = mkTab({ id: "to", type: "settings", resourceType: undefined });
    const loadResources = mock(async (_type: string) => {});
    const k8s = mkStore({ loadResources });

    handleTabSwitch(undefined, toTab, k8s);

    expect(loadResources).not.toHaveBeenCalled();
  });
});

describe("handleTabSwitch — restored resource tab rehydration", () => {
  const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

  test("uncached details tab re-fetches by ref and selects the result", async () => {
    const pod = mkResource("restored-pod");
    const resolve = mock(async () => pod);
    const store = mkStore({ resolveResourceByRef: resolve });
    const tab = mkTab({ id: "tab-d", type: "details", resourceName: "restored-pod", resourceType: "Pod", namespace: "default" });

    handleTabSwitch(undefined, tab, store, () => true);
    expect(store.selectedResource).toBeNull(); // cleared while in flight
    await flushMicrotasks();

    expect(resolve).toHaveBeenCalledWith("Pod", "restored-pod", "default");
    expect(tab.cachedResource).toBe(pod);
    expect(store.selectedResource).toBe(pod);
  });

  test("result is cached but NOT selected when the tab is no longer active", async () => {
    const pod = mkResource("restored-pod");
    const store = mkStore({ resolveResourceByRef: async () => pod });
    const tab = mkTab({ id: "tab-d", type: "details", resourceName: "restored-pod", resourceType: "Pod" });

    handleTabSwitch(undefined, tab, store, () => false);
    await flushMicrotasks();

    expect(tab.cachedResource).toBe(pod);
    expect(store.selectedResource).toBeNull();
  });

  test("fresh open adopts the pre-assigned selection instead of re-fetching", async () => {
    const pod = mkResource("fresh-pod");
    const resolve = mock(async () => null);
    const store = mkStore({ selectedResource: pod, resolveResourceByRef: resolve });
    const tab = mkTab({ id: "tab-d", type: "details", resourceName: "fresh-pod", resourceType: "Pod", namespace: "default" });

    handleTabSwitch(undefined, tab, store, () => true);
    await flushMicrotasks();

    expect(resolve).not.toHaveBeenCalled();
    expect(tab.cachedResource).toBe(pod);
    expect(store.selectedResource).toBe(pod);
  });

  test("cached resource tab restores from cache without fetching", async () => {
    const pod = mkResource("cached-pod");
    const resolve = mock(async () => null);
    const store = mkStore({ resolveResourceByRef: resolve });
    const tab = mkTab({ id: "tab-d", type: "details", resourceName: "cached-pod", resourceType: "Pod", cachedResource: pod });

    handleTabSwitch(undefined, tab, store, () => true);
    await flushMicrotasks();

    expect(resolve).not.toHaveBeenCalled();
    expect(store.selectedResource).toBe(pod);
  });
});

describe("handleTabSwitch — crd-table path", () => {
  test("crd-table cache hit restores via restoreResources", () => {
    const items = [mkResource("crd-a")];
    const toTab: Tab = {
      id: "to",
      type: "crd-table",
      label: "Foo",
      closable: true,
      resourceType: "foos.example.com",
      namespace: "default",
      cachedItems: new CachedItems(items),
      cacheReady: true,
    };
    const restoreResources = mock((_type: string, _items: Resource[]) => {});
    const k8s = mkStore({ currentNamespace: "default", restoreResources });

    handleTabSwitch(undefined, toTab, k8s);

    expect(restoreResources).toHaveBeenCalledWith("foos.example.com", items);
  });
});
