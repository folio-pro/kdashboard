import type { Resource, ResourceList } from "$lib/types";
import type { Tab } from "$lib/stores/ui.logic";
import { RESOURCE_TAB_TYPES } from "$lib/stores/ui.logic";

/**
 * Minimal k8s store surface used by the tab lifecycle. Kept narrow so the
 * logic can be unit-tested against a hand-rolled fake without importing
 * the real store (and its Tauri dependency).
 */
export interface TabLifecycleK8sStore {
  selectedResource: Resource | null;
  resources: ResourceList;
  currentNamespace: string;
  selectedResourceType: string;
  isLoading: boolean;
  error: string | null;
  selectResource(resource: Resource | null): void;
  setResourceType(resourceType: string): void;
  restoreResources(resourceType: string, items: Resource[]): void;
  switchNamespace(namespace: string): Promise<void>;
  loadResources(resourceType: string): Promise<void>;
}

type TableTabType = Extract<Tab["type"], "table" | "crd-table">;

function isTableTab(tab: Tab | undefined): tab is Tab & { type: TableTabType } {
  return !!tab && (tab.type === "table" || tab.type === "crd-table");
}

/**
 * Run synchronously before a tab switch commits:
 *   1. save outgoing tab's selected resource + visible items (cache),
 *   2. restore incoming tab's selected resource,
 *   3. for table tabs: hydrate from cache if ready, else kick a load.
 *
 * Extracted from App.svelte so the race-guard and namespace-sync logic can
 * be exercised without mounting the component.
 */
export function handleTabSwitch(
  fromTab: Tab | undefined,
  toTab: Tab,
  k8s: TabLifecycleK8sStore,
): void {
  saveOutgoingTabState(fromTab, k8s);
  restoreIncomingSelection(toTab, k8s);

  if (!isTableTab(toTab) || !toTab.resourceType) return;

  if (toTab.cacheReady && toTab.cachedItems) {
    restoreFromCache(toTab, k8s);
  } else {
    triggerLoad(toTab, k8s);
  }
}

function saveOutgoingTabState(
  fromTab: Tab | undefined,
  k8s: TabLifecycleK8sStore,
): void {
  if (!fromTab) return;

  if (RESOURCE_TAB_TYPES.has(fromTab.type) && k8s.selectedResource) {
    fromTab.cachedResource = k8s.selectedResource;
  }

  // Skip save when store holds a different resource_type (in-flight load).
  if (isTableTab(fromTab) && fromTab.resourceType) {
    if (k8s.resources.resource_type === fromTab.resourceType) {
      fromTab.cachedItems = k8s.resources.items;
      fromTab.count = k8s.resources.items.length;
      fromTab.cacheReady = true;
    }
  }
}

function restoreIncomingSelection(toTab: Tab, k8s: TabLifecycleK8sStore): void {
  if (RESOURCE_TAB_TYPES.has(toTab.type) && toTab.cachedResource) {
    k8s.selectResource(toTab.cachedResource);
  }
}

function restoreFromCache(toTab: Tab, k8s: TabLifecycleK8sStore): void {
  // Cached: set namespace synchronously (no async switchNamespace to avoid race)
  if (toTab.namespace !== undefined && toTab.namespace !== k8s.currentNamespace) {
    k8s.currentNamespace = toTab.namespace;
  }
  // resourceType guaranteed by caller guard in handleTabSwitch.
  k8s.restoreResources(toTab.resourceType!, toTab.cachedItems!);
}

function triggerLoad(toTab: Tab, k8s: TabLifecycleK8sStore): void {
  // No cache: fetch. Set the type first so switchNamespace's internal load
  // picks up the new resourceType and we don't fire two concurrent
  // list_resources calls.
  const expectedType = toTab.resourceType!;
  k8s.setResourceType(expectedType);
  toTab.cacheReady = false;

  const tabNamespace = toTab.namespace;
  const needsNamespaceSwitch =
    tabNamespace !== undefined && tabNamespace !== k8s.currentNamespace;

  const loadPromise: Promise<void> = needsNamespaceSwitch
    ? k8s.switchNamespace(tabNamespace)
    : (() => {
        k8s.isLoading = true;
        k8s.resources = { items: [], resource_type: expectedType };
        return k8s.loadResources(expectedType);
      })();

  loadPromise
    .then(() => {
      if (k8s.selectedResourceType === expectedType && !k8s.error) {
        toTab.cachedItems = k8s.resources.items;
        toTab.count = k8s.resources.items.length;
        toTab.cacheReady = true;
      }
    })
    .catch((err) => {
      // Store methods currently swallow errors internally and set k8s.error.
      // This catch is defensive — if a future change re-throws, we still
      // avoid an unhandled promise rejection and surface the problem.
      console.error("[tabLifecycle] load for tab failed", {
        tabId: toTab.id,
        resourceType: expectedType,
        error: err,
      });
    });
}
