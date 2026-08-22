import type { CrdInfo, Resource } from "$lib/types";
import { k8sStore } from "$lib/stores/k8s.svelte";
import { uiStore, DEFAULT_RESOURCE_TYPE } from "$lib/stores/ui.svelte";
import { toastStore } from "$lib/stores/toast.svelte";
import { extensions } from "$lib/extensions";
import { topologyStore } from "$lib/stores/topology.svelte";
import { costStore } from "$lib/stores/cost.svelte";
import { securityStore } from "$lib/stores/security.svelte";
import { helmStore } from "$lib/stores/helm.svelte";
import { overviewStore } from "$lib/stores/overview.svelte";
import { portForwardStore } from "$lib/stores/port-forwards.svelte";
import type { ActiveView } from "$lib/stores/ui.logic";

/** The standalone views: catalog `type` === view name. */
export type AppViewType = Extract<ActiveView, "portforwards" | "topology" | "cost" | "security" | "helm" | "overview" | "problems">;

/**
 * Catalog entries that are standalone views rather than resource lists. The
 * value is what the view needs loaded on entry, or null if it loads itself.
 * One table for the sidebar, the palette and anything else that opens a view
 * by name.
 */
export const APP_VIEWS: Record<AppViewType, ((namespace: string) => void) | null> = {
  portforwards: null,
  topology: (ns) => topologyStore.loadNamespaceTopology(ns),
  cost: (ns) => costStore.loadCostOverview(ns),
  security: (ns) => securityStore.loadSecurityOverview(ns),
  helm: (ns) => helmStore.loadReleases(ns),
  overview: (ns) => overviewStore.loadOverview(ns),
  problems: (ns) => overviewStore.loadOverview(ns),
};

export function isAppView(type: string): type is AppViewType {
  return Object.prototype.hasOwnProperty.call(APP_VIEWS, type);
}

/** Open a standalone view and kick off its load. */
export function openAppView(type: AppViewType, namespace: string = k8sStore.currentNamespace): void {
  uiStore.showView(type);
  APP_VIEWS[type]?.(namespace);
}

/**
 * Open a resource in a new detail tab (synchronous — resource already in hand).
 */
export function openResourceDetail(resource: Resource, resourceType?: string): void {
  // The resource travels WITH the tab (seeded as its cachedResource) instead
  // of being written to the global selection up front: the tab-switch hook
  // snapshots the outgoing tab's selection, so assigning first made the
  // previous tab (e.g. a VPA detail) cache the newly opened resource.
  uiStore.showDetails(
    resource.metadata.name,
    resourceType ?? resource.kind,
    resource.metadata.namespace ?? undefined,
    resource,
  );
  // No tab switch happens when the target tab is already active — make sure
  // the selection still points at the freshly opened resource.
  k8sStore.selectResource(resource);
}

/**
 * Switch kube context. The UI reset seeds the default Pods tab, so the k8s
 * store must be pointed at the same resource type BEFORE switchContext runs
 * its post-connect load — otherwise it fetches whatever type was open in the
 * previous context. Single home for this flow (cluster rail + command
 * palette both trigger it).
 */
export async function switchContext(contextName: string): Promise<void> {
  uiStore.resetForContextChange();
  k8sStore.setResourceType(DEFAULT_RESOURCE_TYPE);
  await extensions.emit({ type: "context-changed", contextName });
  await k8sStore.switchContext(contextName);
  if (k8sStore.currentContext === contextName && k8sStore.connectionStatus === "connected") {
    portForwardStore.onContextConnected(contextName);
  }
}

/**
 * Navigate to a resource table tab (e.g. Pods, Deployments).
 * backToTable handles data loading via onBeforeTabSwitch.
 */
export function navigateToResourceTable(label: string, resourceType: string): void {
  k8sStore.clearNavHistory();
  uiStore.resetSelection();
  k8sStore.selectResource(null);
  uiStore.backToTable(label, resourceType, k8sStore.currentNamespace);
}

/**
 * Navigate to a CRD table tab.
 */
export function navigateToCrdTable(crd: CrdInfo): void {
  k8sStore.clearNavHistory();
  k8sStore.loadCrdResources(crd);
  uiStore.openTab("crd-table", { label: crd.kind, resourceType: `crd:${crd.group}/${crd.kind}`, namespace: k8sStore.currentNamespace });
  k8sStore.selectResource(null);
}

/**
 * Fetch a related resource by type+name and open it in a new detail tab.
 */
export async function openRelatedResourceTab(
  resourceType: string,
  name: string,
  namespace?: string,
): Promise<void> {
  const resource = await k8sStore.fetchResource(resourceType, name, namespace);
  if (!resource) {
    // Referenced-but-missing targets are common (e.g. a VPA whose Deployment
    // was deleted). Silence here reads as the app hanging — say why nothing
    // opened.
    toastStore.error(
      "Resource not found",
      `${resourceType}/${name} does not exist${namespace ? ` in namespace "${namespace}"` : ""}.`,
    );
    return;
  }
  openResourceDetail(resource, resourceType);
}
