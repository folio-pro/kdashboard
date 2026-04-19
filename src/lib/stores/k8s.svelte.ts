import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Resource, ResourceList, ConnectionStatus, PortForwardInfo, CrdGroup, CrdInfo, CrdResourceList } from "../types/index.js";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte.js";
import { K8sStoreLogic, COUNTABLE_RESOURCE_TYPES } from "./k8s.logic.js";
import { unshadowState } from "./_unshadow.js";

export type { WatchEvent, NavigationEntry } from "./k8s.logic.js";
export { COUNTABLE_RESOURCE_TYPES } from "./k8s.logic.js";

class K8sStore extends K8sStoreLogic {
  // Override all state properties with $state runes for Svelte 5 reactivity
  override contexts = $state<string[]>([]);
  override currentContext = $state<string>("");
  override namespaces = $state<string[]>([]);
  override currentNamespace = $state<string>("default");
  override resources = $state<ResourceList>({ items: [], resource_type: "" });
  override selectedResource = $state<Resource | null>(null);
  override selectedResourceType = $state<string>("pods");
  override pendingResourceType = $state<string>("");

  override connectionStatus = $state<ConnectionStatus>("disconnected");
  override isSwitchingContext = $state<boolean>(false);
  override switchingContextTo = $state<string | null>(null);
  override isLoading = $state<boolean>(false);
  override error = $state<string | null>(null);
  override contextsLoadError = $state<string | null>(null);
  override namespacesLoadError = $state<string | null>(null);
  override resourceCounts = $state<Record<string, number>>({});
  override portForwards = $state<PortForwardInfo[]>([]);
  override ageTick = $state(0);

  // CRD state
  override crdGroups = $state<CrdGroup[]>([]);
  override crdResources = $state<CrdResourceList>({ items: [], columns: [] });
  override crdLoading = $state<boolean>(false);
  override crdError = $state<string | null>(null);
  override crdCounts = $state<Record<string, number>>({});
  override selectedCrd = $state<CrdInfo | null>(null);

  // Private members that require Tauri / browser APIs (not in logic class)
  private _ageInterval: ReturnType<typeof setInterval> | null = null;
  private _watchUnlisten: UnlistenFn | null = null;
  private _watchActive = false;
  private _pfUnlisten: UnlistenFn | null = null;
  private _pendingWatchEvents: import("./k8s.logic.js").WatchEvent[] = [];
  private _watchFlushScheduled = false;

  constructor() {
    super();
    unshadowState(this);
  }

  private async _stopAllPortForwards(): Promise<void> {
    const active = [...this.portForwards];
    await Promise.allSettled(
      active.map((pf) => invoke("stop_port_forward", { sessionId: pf.session_id }))
    );
    this.portForwards = [];
  }

  private async _stopTransientSessions(): Promise<void> {
    await this._stopWatch();
    await Promise.allSettled([
      invoke("stop_log_stream"),
      invoke("stop_terminal_exec"),
      this._stopAllPortForwards(),
    ]);
  }

  async loadContexts(): Promise<void> {
    try {
      this.contextsLoadError = null;
      this.error = null;
      this.connectionStatus = "connecting";
      const result = await invoke<string[]>("get_contexts");
      this.contexts = result;
      if (result.length > 0 && !this.currentContext) {
        try {
          this.currentContext = await invoke<string>("get_current_context");
        } catch {
          this.currentContext = result[0];
        }
      }
      this.connectionStatus = "connected";
    } catch (err) {
      const message = `Failed to load contexts: ${err}`;
      this.contextsLoadError = message;
      this.error = message;
      this.connectionStatus = "error";
    }
  }

  async loadNamespaces(scopeGeneration = this._scopeGeneration): Promise<void> {
    try {
      this.namespacesLoadError = null;
      this.error = null;
      const result = await invoke<string[]>("get_namespaces");
      if (scopeGeneration !== this._scopeGeneration) return;
      this.namespaces = result;
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      const message = `Failed to load namespaces: ${err}`;
      this.namespacesLoadError = message;
      this.error = message;
    }
  }

  async switchContext(context: string): Promise<void> {
    const scopeGeneration = this._beginScopeChange();
    this.isSwitchingContext = true;
    this.switchingContextTo = context;
    try {
      await this._stopTransientSessions();
      if (scopeGeneration !== this._scopeGeneration) return;

      this.connectionStatus = "connecting";
      await invoke("switch_context", { context });
      if (scopeGeneration !== this._scopeGeneration) return;

      this._resetVisibleState({ clearNamespaces: true });
      this.currentContext = context;
      await this.loadNamespaces(scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;

      const fallbackNamespace = this.namespaces.includes(this.currentNamespace)
        ? this.currentNamespace
        : this.namespaces.includes("default")
          ? "default"
          : (this.namespaces[0] ?? "");
      this.currentNamespace = fallbackNamespace;

      await this.loadResources(this.selectedResourceType, scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;
      this.connectionStatus = "connected";
      this._persistSelection();
      // Refresh sidebar counts in background for new context
      void this.loadAllResourceCounts(scopeGeneration);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to switch context: ${err}`;
      this.connectionStatus = "error";
    } finally {
      if (scopeGeneration === this._scopeGeneration) {
        this.isSwitchingContext = false;
        this.switchingContextTo = null;
      }
    }
  }

  async switchNamespace(namespace: string): Promise<void> {
    const scopeGeneration = this._beginScopeChange();
    try {
      await this._stopTransientSessions();
      if (scopeGeneration !== this._scopeGeneration) return;

      this.currentNamespace = namespace;
      this._resetVisibleState({ keepNamespace: namespace });
      await this.loadResources(this.selectedResourceType, scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;
      this._persistSelection();
      // Refresh sidebar counts in background for new namespace
      void this.loadAllResourceCounts(scopeGeneration);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to switch namespace: ${err}`;
    }
  }

  async loadResources(resourceType: string, scopeGeneration = this._scopeGeneration): Promise<void> {
    const timer = setTimeout(() => { this.isLoading = true; }, 200);
    try {
      this.error = null;
      this.pendingResourceType = resourceType;
      const result = await this._listResources(resourceType);
      if (scopeGeneration !== this._scopeGeneration) return;
      if (this.pendingResourceType !== resourceType) return;
      this.selectedResourceType = resourceType;
      this.resources = result;
      this._setCount(resourceType, result.items.length);
      this._startWatch(resourceType, this.currentNamespace);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to load resources: ${err}`;
      this.resources = { items: [], resource_type: resourceType };
    } finally {
      clearTimeout(timer);
      if (scopeGeneration === this._scopeGeneration) {
        this.isLoading = false;
      }
    }
  }

  /** Restore resources from tab cache without fetching */
  restoreResources(resourceType: string, items: Resource[]): void {
    this.restoreResourcesSync(resourceType, items);
    this._startWatch(resourceType, this.currentNamespace);
  }

  /** Fetch a single resource by type and name without changing current view state. */
  async fetchResource(resourceType: string, name: string, namespace?: string): Promise<Resource | null> {
    const result = await this._listResources(resourceType);
    return result.items.find(
      (r) => r.metadata.name === name && (!namespace || r.metadata.namespace === namespace)
    ) ?? null;
  }

  /** @deprecated Use openRelatedResourceTab() or openResourceDetail() instead */
  async navigateToRelated(resourceType: string, name: string, namespace?: string): Promise<void> {
    // Push current state
    if (this.selectedResource) {
      this._navHistory.push({
        resourceType: this.selectedResourceType,
        resource: this.selectedResource,
      });
    }

    await this.loadResources(resourceType);

    // Find the target resource by name (and namespace if provided)
    const target = this.resources.items.find(
      (r) => r.metadata.name === name && (!namespace || r.metadata.namespace === namespace)
    );
    this.selectedResource = target ?? null;
  }

  /** Go back to the previous detail view from the navigation history. Returns true if navigated back. */
  override navigateBack(): boolean {
    const entry = this._navHistory.pop();
    if (!entry) return false;

    this.setResourceType(entry.resourceType);
    this.selectedResource = entry.resource;
    // Reload resources for the previous type in background
    this._listResources(entry.resourceType).then((result) => {
      this.resources = result;
      this._setCount(entry.resourceType, result.items.length);
      this._startWatch(entry.resourceType, this.currentNamespace);
      // Re-find the resource in case it was updated
      const updated = result.items.find((r) => r.metadata.uid === entry.resource.metadata.uid);
      if (updated) this.selectedResource = updated;
    }).catch(() => {
      // keep the stale resource for display
    });

    return true;
  }

  /** Navigate back to a specific breadcrumb level, popping everything after it. */
  override navigateToHistoryIndex(index: number): void {
    if (index < 0 || index >= this._navHistory.length) return;
    const entry = this._navHistory[index];
    this._navHistory = this._navHistory.slice(0, index);
    this.setResourceType(entry.resourceType);
    this.selectedResource = entry.resource;
    const expectedType = entry.resourceType;
    this._listResources(expectedType).then((result) => {
      if (this.selectedResourceType !== expectedType) return;
      this.resources = result;
      this._setCount(expectedType, result.items.length);
      this._startWatch(expectedType, this.currentNamespace);
      const updated = result.items.find((r) => r.metadata.uid === entry.resource.metadata.uid);
      if (updated) this.selectedResource = updated;
    }).catch(() => {});
  }

  async refreshResources(): Promise<void> {
    await this.loadResources(this.selectedResourceType);
  }

  async resetForUserSwitch(): Promise<void> {
    this._beginScopeChange();
    this.isSwitchingContext = false;
    this.switchingContextTo = null;
    await this._stopTransientSessions();
    this.setResourceType("pods");
    this._resetVisibleState({
      clearContexts: true,
      clearNamespaces: true,
      keepNamespace: "default",
    });
    settingsStore.updateConnection("", "default");
  }

  /** Load counts for all resource types via a single batch Tauri command. */
  async loadAllResourceCounts(scopeGeneration = this._scopeGeneration): Promise<void> {
    const gen = ++this._countGeneration;
    const namespace = this.currentNamespace;
    try {
      const counts = await invoke<Record<string, number>>("get_resource_counts", {
        resourceTypes: [...COUNTABLE_RESOURCE_TYPES],
        namespace,
      });
      // Discard stale results if namespace/context changed while in-flight
      if (gen !== this._countGeneration || scopeGeneration !== this._scopeGeneration) return;
      this.resourceCounts = { ...this.resourceCounts, ...counts };
    } catch {
      // silently ignore - sidebar badges are optional
    }
  }

  async restoreConnection(context: string | undefined, namespace: string | undefined): Promise<void> {
    try {
      if (context && this.contexts.includes(context) && context !== this.currentContext) {
        this.connectionStatus = "connecting";
        await invoke("switch_context", { context });
        this.currentContext = context;
        this.connectionStatus = "connected";
      }
      if (namespace) {
        this.currentNamespace = namespace;
      }
    } catch (err) {
      this.error = `Failed to restore connection: ${err}`;
      this.connectionStatus = "error";
    }
  }

  private _persistSelection(): void {
    settingsStore.updateConnection(this.currentContext, this.currentNamespace);
  }

  private async _listResources(resourceType: string): Promise<ResourceList> {
    return invoke<ResourceList>("list_resources", {
      resourceType,
      namespace: this.currentNamespace,
    });
  }

  private async _startWatch(resourceType: string, namespace: string): Promise<void> {
    await this._stopWatch();
    // Start age ticker every 30s to refresh displayed ages (1s is wasteful – age labels barely change)
    this._ageInterval = setInterval(() => { this.ageTick++; }, 30_000);
    try {
      // Listen for watch events from the backend
      this._watchUnlisten = await listen<import("./k8s.logic.js").WatchEvent>("resource-watch-event", (event) => {
        this._handleWatchEvent(event.payload);
      });
      // Start the backend watcher
      await invoke("start_resource_watch", {
        resourceType,
        namespace,
      });
      this._watchActive = true;
    } catch (err) {
      if (import.meta.env.DEV) console.warn("Failed to start resource watch:", err);
    }
  }

  private async _stopWatch(): Promise<void> {
    this._pendingWatchEvents = [];
    this._watchFlushScheduled = false;
    if (this._ageInterval) {
      clearInterval(this._ageInterval);
      this._ageInterval = null;
    }
    if (this._watchActive) {
      try {
        await invoke("stop_resource_watch");
      } catch {
        // ignore stop errors
      }
      this._watchActive = false;
    }
    if (this._watchUnlisten) {
      this._watchUnlisten();
      this._watchUnlisten = null;
    }
  }

  private _handleWatchEvent(event: import("./k8s.logic.js").WatchEvent): void {
    // Only process events for the currently viewed resource type
    if (event.resource_type !== this.selectedResourceType) return;

    // Resync: watcher reconnected after a gap, do a full refresh
    if (event.event_type === "Resync") {
      this._pendingWatchEvents = [];
      this._watchFlushScheduled = false;
      this._refreshAfterResync();
      return;
    }

    this._pendingWatchEvents.push(event);
    if (!this._watchFlushScheduled) {
      this._watchFlushScheduled = true;
      requestAnimationFrame(() => this._flushWatchEvents());
    }
  }

  private _flushWatchEvents(): void {
    const batch = this._pendingWatchEvents;
    this._pendingWatchEvents = [];
    this._watchFlushScheduled = false;

    if (batch.length === 0) return;

    // Guard: discard stale events if context/namespace changed during the frame
    const scopeGen = this._scopeGeneration;

    const items = this.resources.items;
    let selectedResourceUpdate: Resource | null | undefined;

    for (const event of batch) {
      // Double-check scope hasn't changed mid-flush
      if (this._scopeGeneration !== scopeGen) return;

      const uid = event.resource.metadata?.uid;
      if (!uid) continue;

      if (event.event_type === "Applied") {
        const idx = items.findIndex((r) => r.metadata?.uid === uid);
        if (idx >= 0) {
          items[idx] = event.resource;
        } else {
          items.push(event.resource);
        }
        if (this.selectedResource?.metadata?.uid === uid) {
          selectedResourceUpdate = event.resource;
        }
      } else if (event.event_type === "Deleted") {
        const idx = items.findIndex((r) => r.metadata?.uid === uid);
        if (idx >= 0) {
          items.splice(idx, 1);
          if (this.selectedResource?.metadata?.uid === uid) {
            selectedResourceUpdate = null;
          }
        }
      }
    }

    // Trigger Svelte 5 reactivity ONCE for the entire batch
    this.resources = { ...this.resources, items };
    this._setCount(this.selectedResourceType, items.length);

    if (selectedResourceUpdate !== undefined) {
      this.selectedResource = selectedResourceUpdate;
    }
  }

  private async _refreshAfterResync(): Promise<void> {
    try {
      const result = await this._listResources(this.selectedResourceType);
      this.resources = result;
      this._setCount(this.selectedResourceType, result.items.length);
    } catch (err) {
      if (import.meta.env.DEV) console.warn("Failed to refresh after resync:", err);
    }
  }

  private async _ensurePortForwardListener(): Promise<void> {
    if (this._pfUnlisten) return;
    this._pfUnlisten = await listen<string>("port-forward-closed", (event) => {
      const sessionId = event.payload;
      const pf = this.portForwards.find((p) => p.session_id === sessionId);
      if (pf) {
        this.portForwards = this.portForwards.filter((p) => p.session_id !== sessionId);
        toastStore.warning(
          "Port forward stopped",
          `Forward to ${pf.pod_name}:${pf.container_port} ended unexpectedly`,
        );
      }
    });
  }

  async addPortForward(info: PortForwardInfo): Promise<void> {
    await this._ensurePortForwardListener();
    try {
      const result = await invoke<{ session_id: string; local_port: number }>(
        "start_port_forward",
        {
          podName: info.pod_name,
          namespace: info.namespace,
          containerPort: info.container_port,
          localPort: info.local_port,
          sessionId: info.session_id,
        }
      );
      this.portForwards = [
        ...this.portForwards,
        { ...info, local_port: result.local_port, session_id: result.session_id },
      ];
    } catch (err) {
      this.error = `Failed to start port forward: ${err}`;
    }
  }

  async removePortForward(sessionId: string): Promise<void> {
    try {
      await invoke("stop_port_forward", { sessionId });
    } catch {
      // ignore stop errors (session may already be gone)
    }
    this.portForwards = this.portForwards.filter((pf) => pf.session_id !== sessionId);
  }

  // =========================================================================
  // CRD Discovery & Browsing
  // =========================================================================

  async discoverCrds(): Promise<void> {
    const scopeGeneration = this._scopeGeneration;
    this.crdLoading = true;
    this.crdError = null;
    try {
      const groups = await invoke<CrdGroup[]>("discover_crds");
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdGroups = groups;
    } catch (e) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdError = String(e);
      // Only reassign if non-empty — a new `[]` reference would invalidate
      // reactive readers (e.g. Sidebar's discovery effect) and retrigger
      // discoverCrds, producing an infinite loop when the API keeps failing.
      if (this.crdGroups.length > 0) this.crdGroups = [];
    } finally {
      this.crdLoading = false;
    }
  }

  async loadCrdResources(crd: CrdInfo): Promise<void> {
    const scopeGeneration = this._scopeGeneration;
    this.selectedCrd = crd;
    this.crdResources = { items: [], columns: [] };
    this.isLoading = true;
    try {
      const result = await invoke<CrdResourceList>("list_crd_resources", {
        group: crd.group,
        version: crd.version,
        kind: crd.kind,
        plural: crd.plural,
        scope: crd.scope,
        namespace: crd.scope === "Namespaced" ? this.currentNamespace : null,
      });
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdResources = result;
    } catch (e) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdResources = { items: [], columns: [] };
      toastStore.error("Failed to load CRD resources", String(e));
    } finally {
      this.isLoading = false;
    }
  }

  async loadCrdCounts(crds: CrdInfo[]): Promise<void> {
    if (crds.length === 0) return;
    try {
      const counts = await invoke<Record<string, number>>("get_crd_counts", {
        crds,
        namespace: this.currentNamespace,
      });
      this.crdCounts = { ...this.crdCounts, ...counts };
    } catch {
      // Silently fail — counts are non-essential
    }
  }
}

export type { K8sStore };
export const k8sStore = new K8sStore();
