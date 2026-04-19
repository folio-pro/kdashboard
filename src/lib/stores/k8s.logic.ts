import type {
  Resource,
  ResourceList,
  ConnectionStatus,
  PortForwardInfo,
  CrdGroup,
  CrdInfo,
  CrdResourceList,
} from "../types/index.js";

export interface WatchEvent {
  event_type: "Applied" | "Deleted" | "Resync";
  resource_type: string;
  resource: Resource;
}

export interface NavigationEntry {
  resourceType: string;
  resource: Resource;
}

export const COUNTABLE_RESOURCE_TYPES = [
  "pods", "deployments", "replicasets", "statefulsets", "daemonsets",
  "jobs", "cronjobs", "services", "ingresses", "configmaps", "secrets",
  "hpa", "vpa", "nodes", "namespaces", "persistentvolumes", "persistentvolumeclaims",
  "storageclasses", "roles", "rolebindings", "clusterroles", "clusterrolebindings",
  "networkpolicies", "resourcequotas", "limitranges", "poddisruptionbudgets",
] as const;

/**
 * Pure logic for K8sStore — no Svelte runes, no Tauri invoke.
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

  // CRD state
  crdGroups: CrdGroup[] = [];
  crdResources: CrdResourceList = { items: [], columns: [] };
  crdLoading: boolean = false;
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
    this.resources = { items: [], resource_type: this.selectedResourceType };
    this.selectedResource = null;
    this.clearNavHistory();
    this.resourceCounts = {};
    this.crdGroups = [];
    this.crdResources = { items: [], columns: [] };
    this.crdCounts = {};
    this.selectedCrd = null;
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

  /** Restore resources from tab cache without fetching */
  restoreResourcesSync(resourceType: string, items: Resource[]): void {
    this._scopeGeneration++;
    this.setResourceType(resourceType);
    this.resources = { items, resource_type: resourceType };
    this._setCount(resourceType, items.length);
    this.isLoading = false;
    this.error = null;
  }

  _setCount(resourceType: string, count: number): void {
    // Skip reactive update if count hasn't changed
    if (this.resourceCounts[resourceType] === count) return;
    this.resourceCounts = { ...this.resourceCounts, [resourceType]: count };
  }

  /** Synchronous navigate-to-related for testing (no Tauri calls). */
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
      // In the real store this triggers a full refresh via Tauri
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
      this.resources = { ...this.resources, items };
      this._setCount(event.resource_type, items.length);
      if (this.selectedResource?.metadata?.uid === uid) {
        this.selectedResource = event.resource;
      }
    } else if (event.event_type === "Deleted") {
      const items = this.resources.items;
      const idx = items.findIndex((r) => r.metadata?.uid === uid);
      if (idx >= 0) {
        items.splice(idx, 1);
        this.resources = { ...this.resources, items };
        this._setCount(event.resource_type, items.length);
        if (this.selectedResource?.metadata?.uid === uid) {
          this.selectedResource = null;
        }
      }
    }
  }

  /** Synchronous port forward add (no Tauri calls). */
  addPortForwardSync(info: PortForwardInfo): void {
    this.portForwards = [...this.portForwards, info];
  }

  /** Synchronous port forward remove (no Tauri calls). */
  removePortForwardSync(sessionId: string): void {
    this.portForwards = this.portForwards.filter((pf) => pf.session_id !== sessionId);
  }

  /** Synchronous portion of resetForUserSwitch (no Tauri calls). */
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
