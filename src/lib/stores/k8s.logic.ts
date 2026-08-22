import type {
  Resource,
  ResourceList,
  ConnectionStatus,
  PortForwardInfo,
  CrdGroup,
  CrdInfo,
  CrdResourceList,
} from "../types/index.js";
import { LISTABLE_RESOURCE_TYPES } from "../resource-catalog.js";

export interface WatchEvent {
  event_type: "Applied" | "Deleted" | "Resync";
  resource_type: string;
  resource: Resource;
}

export interface NavigationEntry {
  resourceType: string;
  resource: Resource;
}

/** Types the sidebar shows a live count for — every listable catalog entry. */
export const COUNTABLE_RESOURCE_TYPES: readonly string[] = LISTABLE_RESOURCE_TYPES;

/**
 * Pure logic for K8sStore — no Svelte runes, no backend invoke.
 * Testable in bun test. The Svelte store extends this and adds reactivity.
 */
export class K8sStoreLogic {
  contexts: string[] = [];
  currentContext: string = "";
  namespaces: string[] = [];
  currentNamespace: string = "default";
  resources: ResourceList = { items: [], resource_type: "" };
  selectedResource: Resource | null = null;
  selectedResourceType: string = "pods";
  /** The type being loaded — used by sidebar for immediate highlight */
  pendingResourceType: string = "";

  connectionStatus: ConnectionStatus = "disconnected";
  isSwitchingContext: boolean = false;
  switchingContextTo: string | null = null;
  isLoading: boolean = false;
  error: string | null = null;
  contextsLoadError: string | null = null;
  namespacesLoadError: string | null = null;
  resourceCounts: Record<string, number> = {};
  portForwards: PortForwardInfo[] = [];
  ageTick: number = 0;
  /**
   * False until the CURRENT view's first list completes (or cache restores).
   * Distinguishes "never loaded yet" (show loading) from "loaded, genuinely
   * empty" (show empty state) — isLoading alone can't: it is deliberately
   * delayed 200ms to avoid flicker, which flashed "No pods found" on boot.
   */
  viewLoaded: boolean = false;
  /** Epoch ms of the last list or watch delta applied to `resources`. 0 = never. */
  lastUpdatedAt: number = 0;
  /** True while the backend watcher for the current view is running. */
  watching: boolean = false;

  // CRD state
  crdGroups: CrdGroup[] = [];
  crdResources: CrdResourceList = { items: [], columns: [] };
  crdLoading: boolean = false;
  /** True once discover_crds has completed successfully for the current scope.
   *  Distinguishes "not discovered yet" from "cluster has zero CRDs" — deriving
   *  that from crdGroups.length re-triggers discovery forever on empty clusters. */
  crdDiscovered: boolean = false;
  crdError: string | null = null;
  crdCounts: Record<string, number> = {};
  /** Currently selected CRD type (e.g., "datadoghq.com/WatermarkPodAutoscaler") */
  selectedCrd: CrdInfo | null = null;

  /** Stack for related-resource drill-down navigation */
  protected _navHistory: NavigationEntry[] = [];

  get hasNavHistory(): boolean {
    return this._navHistory.length > 0;
  }

  get breadcrumbTrail(): Array<{ kind: string; name: string }> {
    return this._navHistory.map((e) => ({
      kind: e.resource.kind,
      name: e.resource.metadata.name,
    }));
  }

  _countGeneration = 0;
  _scopeGeneration = 0;

  /** Set both resource type states atomically (for non-async transitions) */
  setResourceType(type: string): void {
    if (type !== this.selectedResourceType) this.viewLoaded = false;
    this.selectedResourceType = type;
    this.pendingResourceType = type;
  }

  _resetVisibleState(options?: {
    clearContexts?: boolean;
    clearNamespaces?: boolean;
    keepNamespace?: string;
  }): void {
    this.error = null;
    this.contextsLoadError = null;
    this.namespacesLoadError = null;
    this.viewLoaded = false;
    this._replaceResources({ items: [], resource_type: this.selectedResourceType }, 0);
    this.selectedResource = null;
    this.clearNavHistory();
    this.resourceCounts = {};
    this.crdGroups = [];
    this.crdResources = { items: [], columns: [] };
    this.crdCounts = {};
    this.selectedCrd = null;
    this.crdDiscovered = false;
    this.crdError = null;

    if (options?.clearContexts) {
      this.contexts = [];
      this.currentContext = "";
      this.connectionStatus = "disconnected";
    }

    if (options?.clearNamespaces) {
      this.namespaces = [];
    }

    this.currentNamespace = options?.keepNamespace ?? this.currentNamespace;
  }

  _beginScopeChange(): number {
    this._scopeGeneration += 1;
    this._countGeneration += 1;
    return this._scopeGeneration;
  }

  selectResource(resource: Resource | null): void {
    this.selectedResource = resource;
  }

  /** Clear navigation history (e.g. when switching context/namespace) */
  clearNavHistory(): void {
    this._navHistory = [];
  }

  /** Go back to the previous detail view from the navigation history. Returns true if navigated back. */
  navigateBack(): boolean {
    const entry = this._navHistory.pop();
    if (!entry) return false;

    this.setResourceType(entry.resourceType);
    this.selectedResource = entry.resource;
    return true;
  }

  /** Navigate back to a specific breadcrumb level, popping everything after it. */
  navigateToHistoryIndex(index: number): void {
    if (index < 0 || index >= this._navHistory.length) return;
    const entry = this._navHistory[index];
    this._navHistory = this._navHistory.slice(0, index);
    this.setResourceType(entry.resourceType);
    this.selectedResource = entry.resource;
  }

  /**
   * Swap in a list of resources and say when it arrived. Every replacement of
   * `resources` goes through here so the status bar's "updated Ns ago" can
   * never describe a different view than the rows under it; pass 0 for a list
   * whose age is unknown (cleared, or restored from a tab cache) and the
   * label stays blank until the next list lands.
   */
  _replaceResources(list: ResourceList, at: number): void {
    this.resources = list;
    this.lastUpdatedAt = at;
  }

  /** Restore resources from tab cache without fetching */
  restoreResourcesSync(resourceType: string, items: Resource[]): void {
    this._scopeGeneration++;
    this.setResourceType(resourceType);
    this._replaceResources({ items, resource_type: resourceType }, 0);
    this._setCount(resourceType, items.length);
    this.isLoading = false;
    this.error = null;
    this.viewLoaded = true;
  }

  /**
   * Adopt a restored namespace only if it is usable in THIS cluster, then make
   * sure currentNamespace itself is real. A candidate is adopted when non-empty
   * ("" would list at CLUSTER scope — 403 under restrictive RBAC, and the
   * picker offers no way out) and present in the loaded namespace list (tabs/
   * settings can carry one from another context — listing there returns empty
   * forever). With no list loaded, the candidate is trusted as-is.
   */
  restoreNamespace(candidate?: string): void {
    const nss = this.namespaces;
    if (candidate && (nss.length === 0 || nss.includes(candidate))) {
      this.currentNamespace = candidate;
      return;
    }
    if (nss.length > 0 && !nss.includes(this.currentNamespace)) {
      this.currentNamespace = nss.includes("default") ? "default" : nss[0];
    }
  }

  _setCount(resourceType: string, count: number): void {
    // Skip reactive update if count hasn't changed
    if (this.resourceCounts[resourceType] === count) return;
    this.resourceCounts = { ...this.resourceCounts, [resourceType]: count };
  }

  /** Synchronous navigate-to-related for testing (no backend calls). */
  navigateToRelatedSync(resourceType: string, target: Resource | null): void {
    if (this.selectedResource) {
      this._navHistory.push({
        resourceType: this.selectedResourceType,
        resource: this.selectedResource,
      });
    }
    this.selectedResourceType = resourceType;
    this.selectedResource = target;
  }

  /** Handle a single watch event (used by flush in the Svelte store). */
  handleWatchEvent(event: WatchEvent): void {
    if (event.resource_type !== this.selectedResourceType) return;

    if (event.event_type === "Resync") {
      // In the real store this triggers a full refresh via the backend
      return;
    }

    const uid = event.resource.metadata?.uid;
    if (!uid) return;

    if (event.event_type === "Applied") {
      const items = this.resources.items;
      const idx = items.findIndex((r) => r.metadata?.uid === uid);
      if (idx >= 0) {
        items[idx] = event.resource;
      } else {
        items.push(event.resource);
      }
      this._replaceResources({ ...this.resources, items }, Date.now());
      this._setCount(event.resource_type, items.length);
      if (this.selectedResource?.metadata?.uid === uid) {
        this.selectedResource = event.resource;
      }
    } else if (event.event_type === "Deleted") {
      const items = this.resources.items;
      const idx = items.findIndex((r) => r.metadata?.uid === uid);
      if (idx >= 0) {
        items.splice(idx, 1);
        this._replaceResources({ ...this.resources, items }, Date.now());
        this._setCount(event.resource_type, items.length);
        if (this.selectedResource?.metadata?.uid === uid) {
          this.selectedResource = null;
        }
      }
    }
  }

  /** Synchronous port forward add (no backend calls). */
  addPortForwardSync(info: PortForwardInfo): void {
    this.portForwards = [...this.portForwards, info];
  }

  /** Synchronous port forward remove (no backend calls). */
  removePortForwardSync(sessionId: string): void {
    this.portForwards = this.portForwards.filter((pf) => pf.session_id !== sessionId);
  }

  /** Synchronous portion of resetForUserSwitch (no backend calls). */
  resetForUserSwitchSync(): void {
    this._beginScopeChange();
    this.isSwitchingContext = false;
    this.switchingContextTo = null;
    this.setResourceType("pods");
    this._resetVisibleState({
      clearContexts: true,
      clearNamespaces: true,
      keepNamespace: "default",
    });
  }

  /** Get display key for a CRD (used for counts map) */
  crdKey(crd: CrdInfo): string {
    return `${crd.group}/${crd.kind}`;
  }
}
