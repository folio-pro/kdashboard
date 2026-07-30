import type {
  Resource,
  ResourceList,
  ConnectionStatus,
  PortForwardInfo,
  CrdGroup,
  CrdInfo,
  CrdResourceList,
} from "../types/index.js";
import type { KubeIo, Unsubscribe } from "./k8s.io.js";

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

  // ── Backend seam + watch lifecycle ──
  // Moved here from the Svelte subclass so the load → cache → watch → reconcile
  // orchestration depends only on the injected KubeIo port and is exercisable
  // in bun test against a fake adapter.
  protected _ageInterval: ReturnType<typeof setInterval> | null = null;
  protected _watchUnlisten: Unsubscribe | null = null;
  protected _watchActive = false;
  protected _pendingWatchEvents: WatchEvent[] = [];
  protected _watchFlushScheduled = false;
  // Serializes start/stop so two fire-and-forget callers can't race on the
  // single interval/listener slots and orphan a timer or listener.
  protected _watchOp: Promise<void> = Promise.resolve();

  constructor(protected io: KubeIo) {}

  /**
   * How a pending watch-event batch is scheduled to flush. The base batches on
   * a microtask — deterministic, and works under bun test. The Svelte store
   * overrides this with requestAnimationFrame to coalesce within a frame.
   */
  protected _scheduleFlush(flush: () => void): void {
    queueMicrotask(flush);
  }

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

  // =========================================================================
  // Resource load / watch / reconcile orchestration
  // Depends only on the injected KubeIo, so the whole state machine (scope
  // guards, cache-vs-load-vs-reconcile, watch start/stop, batched flush,
  // resync) is exercisable in bun test via a fake adapter.
  // =========================================================================

  async loadResources(resourceType: string, scopeGeneration = this._scopeGeneration): Promise<void> {
    const timer = setTimeout(() => { this.isLoading = true; }, 200);
    try {
      this.error = null;
      this.pendingResourceType = resourceType;
      const result = await this.io.listResources(resourceType, this.currentNamespace);
      if (scopeGeneration !== this._scopeGeneration) return;
      if (this.pendingResourceType !== resourceType) return;
      this.selectedResourceType = resourceType;
      // Backend ResourceList carries only `items` — stamp resource_type here so
      // downstream cache/save logic (saveOutgoingTabState's guard, watch flush)
      // can trust it. Mirrors restoreResourcesSync.
      this.resources = { items: result.items, resource_type: resourceType };
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

  /** Restore resources from tab cache without fetching, then start a watch. */
  restoreResources(resourceType: string, items: Resource[]): void {
    this.restoreResourcesSync(resourceType, items);
    this._startWatch(resourceType, this.currentNamespace);
  }

  /**
   * Silent background refetch used after a cache-restored tab switch. The
   * cache is a snapshot from when the tab was last active; creates/deletes/
   * modifications that happened while it was inactive are not replayed by the
   * freshly-started watcher (the backend suppresses the initial list on watch
   * start — see k8s/watch.rs), so the cached rows would otherwise stay stale
   * until each object next changes.
   *
   * Unlike loadResources this:
   *   - never flips isLoading (the cached snapshot is already painted),
   *   - keeps the current items on error instead of blanking the table,
   *   - does NOT (re)start the watch — restoreResources already did.
   */
  async reconcileResources(resourceType: string): Promise<void> {
    const scopeGeneration = this._scopeGeneration;
    try {
      const result = await this.io.listResources(resourceType, this.currentNamespace);
      // Discard if the user navigated away (type) or changed scope
      // (namespace/context) while the fetch was in flight.
      if (scopeGeneration !== this._scopeGeneration) return;
      if (this.selectedResourceType !== resourceType) return;
      // Stamp resource_type (backend omits it) so this reconcile doesn't clobber
      // the type that restoreResourcesSync just set — otherwise the next
      // saveOutgoingTabState guard fails and the cache silently stops saving.
      this.resources = { items: result.items, resource_type: resourceType };
      this._setCount(resourceType, result.items.length);
    } catch (err) {
      // Keep the cached snapshot on error — a transient list failure on tab
      // return must not wipe the table to empty.
      if (import.meta.env?.DEV) console.warn("Failed to reconcile after cache restore:", err);
    }
  }

  /** Fetch a single resource by type and name without changing current view state. */
  async fetchResource(resourceType: string, name: string, namespace?: string): Promise<Resource | null> {
    const result = await this.io.listResources(resourceType, this.currentNamespace);
    return result.items.find(
      (r) => r.metadata.name === name && (!namespace || r.metadata.namespace === namespace)
    ) ?? null;
  }

  protected _listResources(resourceType: string): Promise<ResourceList> {
    return this.io.listResources(resourceType, this.currentNamespace);
  }

  protected _startWatch(resourceType: string, namespace: string): Promise<void> {
    // Chain onto the shared op so a stop always completes before the next start
    // runs — no two starts can interleave on the single interval/listener slots.
    this._watchOp = this._watchOp.then(async () => {
      await this._stopWatchInner();
      // Age ticker every 30s to refresh displayed ages (1s is wasteful).
      this._ageInterval = setInterval(() => { this.ageTick++; }, 30_000);
      // Don't hold the process open for the display ticker under bun test.
      (this._ageInterval as { unref?: () => void }).unref?.();
      try {
        this._watchUnlisten = await this.io.onWatchEvent((payload) => {
          this._handleWatchEvents(payload);
        });
        await this.io.startResourceWatch(resourceType, namespace);
        this._watchActive = true;
      } catch (err) {
        if (import.meta.env?.DEV) console.warn("Failed to start resource watch:", err);
      }
    });
    return this._watchOp;
  }

  protected _stopWatch(): Promise<void> {
    this._watchOp = this._watchOp.then(() => this._stopWatchInner());
    return this._watchOp;
  }

  protected async _stopWatchInner(): Promise<void> {
    this._pendingWatchEvents = [];
    this._watchFlushScheduled = false;
    if (this._ageInterval) {
      clearInterval(this._ageInterval);
      this._ageInterval = null;
    }
    if (this._watchActive) {
      try {
        await this.io.stopResourceWatch();
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

  /** Backend may emit a single event or a coalesced batch (array). */
  protected _handleWatchEvents(payload: WatchEvent | WatchEvent[]): void {
    if (Array.isArray(payload)) {
      for (const event of payload) this._handleWatchEvent(event);
    } else {
      this._handleWatchEvent(payload);
    }
  }

  protected _handleWatchEvent(event: WatchEvent): void {
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
      this._scheduleFlush(() => this._flushWatchEvents());
    }
  }

  protected _flushWatchEvents(): void {
    const batch = this._pendingWatchEvents;
    this._pendingWatchEvents = [];
    this._watchFlushScheduled = false;

    if (batch.length === 0) return;

    // Guard: discard stale events if context/namespace changed during the frame.
    const scopeGen = this._scopeGeneration;

    // Build an ordered uid→Resource map once (O(N)) so each event is an O(1)
    // upsert/delete instead of an O(N) findIndex/splice — turns the worst-case
    // O(N·M) flush into O(N+M). Map iteration order matches the current array
    // and set() keeps an existing key's position, so item order is preserved.
    const byUid = new Map<string, Resource>();
    for (const r of this.resources.items) {
      const uid = r.metadata?.uid;
      if (uid) byUid.set(uid, r);
    }

    let selectedResourceUpdate: Resource | null | undefined;
    let changed = false;

    for (const event of batch) {
      if (this._scopeGeneration !== scopeGen) return;

      const uid = event.resource.metadata?.uid;
      if (!uid) continue;

      if (event.event_type === "Applied") {
        byUid.set(uid, event.resource);
        changed = true;
        if (this.selectedResource?.metadata?.uid === uid) {
          selectedResourceUpdate = event.resource;
        }
      } else if (event.event_type === "Deleted") {
        if (byUid.delete(uid)) {
          changed = true;
          if (this.selectedResource?.metadata?.uid === uid) {
            selectedResourceUpdate = null;
          }
        }
      }
    }

    if (changed) {
      const items = Array.from(byUid.values());
      // Trigger reactivity ONCE for the entire batch (fresh array required for
      // $state.raw correctness in the Svelte subclass).
      this.resources = { items, resource_type: this.resources.resource_type };
      this._setCount(this.selectedResourceType, items.length);
    }

    if (selectedResourceUpdate !== undefined) {
      this.selectedResource = selectedResourceUpdate;
    }
  }

  protected async _refreshAfterResync(): Promise<void> {
    try {
      const resourceType = this.selectedResourceType;
      const result = await this.io.listResources(resourceType, this.currentNamespace);
      this.resources = { items: result.items, resource_type: resourceType };
      this._setCount(resourceType, result.items.length);
    } catch (err) {
      if (import.meta.env?.DEV) console.warn("Failed to refresh after resync:", err);
    }
  }
}
