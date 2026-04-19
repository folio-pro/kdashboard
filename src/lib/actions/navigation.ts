import type { CrdInfo, Resource } from "$lib/types";
import { k8sStore } from "$lib/stores/k8s.svelte";
import { uiStore } from "$lib/stores/ui.svelte";

/**
 * Open a resource in a new detail tab (synchronous — resource already in hand).
 */
export function openResourceDetail(resource: Resource, resourceType?: string): void {
  k8sStore.selectedResource = resource;
  uiStore.showDetails(resource.metadata.name, resourceType ?? resource.kind);
  const tab = uiStore.activeTab;
  if (tab) tab.cachedResource = resource;
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
  if (!resource) return;
  openResourceDetail(resource, resourceType);
}
