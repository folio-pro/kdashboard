import { invoke } from "$lib/ipc/core";
import { listen, type UnlistenFn } from "$lib/ipc/event";
import type { Resource, ResourceList, ConnectionStatus, PortForwardInfo, CrdGroup, CrdInfo, CrdResourceList } from "../types/index.js";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte.js";
import { K8sStoreLogic, COUNTABLE_RESOURCE_TYPES } from "./k8s.logic.js";
import { resourceTypeForRef } from "$lib/utils/related-resources";
import { clearClusterCompletionCache } from "$lib/utils/cluster-completion-source";
import { clearOpenApiCache } from "$lib/utils/openapi-schema";
import { scheduleFlush } from "$lib/utils/frame-scheduler";
import { liveValues, signalsFor } from "./live-values.svelte";
import { unshadowState } from "./_unshadow.js";

export type { WatchEvent, NavigationEntry } from "./k8s.logic.js";
export { COUNTABLE_RESOURCE_TYPES } from "./k8s.logic.js";

/** User-facing message from a caught invoke() rejection (no "Error:" prefix). */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A coalesced watch delta. `reinserted` marks a uid whose pending Deleted was
 * superseded by an Applied inside the same batch — a replay would have removed
 * the row and re-appended it, so the flush must move it to the end.
 */
interface PendingWatchEvent {
  event: import("./k8s.logic.js").WatchEvent;
  reinserted: boolean;
}

class K8sStore extends K8sStoreLogic {
  // Override all state properties with $state runes for Svelte 5 reactivity
  override contexts = $state<string[]>([]);
  override currentContext = $state<string>("");
  override namespaces = $state<string[]>([]);
  override currentNamespace = $state<string>("default");
  // $state.raw, not deep $state: k8s payloads are immutable snapshots from the
  // backend — replaced wholesale (never field-mutated by the UI), so per-field
  // reactivity is pure overhead. Deep-proxying every list would allocate tens of
  // thousands of Proxy objects per load at 1-5k items. Every writer below
  // reassigns `resources` to a fresh object, so reactivity still fires; the
  // watch-flush MUST build a new items array (never mutate the stored one).
  override resources = $state.raw<ResourceList>({ items: [], resource_type: "" });
  override selectedResource = $state<Resource | null>(null);
  override selectedResourceType = $state<string>("pods");
  override pendingResourceType = $state<string>("");

  override connectionStatus = $state<ConnectionStatus>("disconnected");
  override isSwitchingContext = $state<boolean>(false);

  /**
   * The cluster itself is unreachable, as opposed to one resource type failing
   * to list. ConnectionErrorOverlay takes over the whole window in this state,
   * so views must not also render their own copy of the error behind it — the
   * table used to, which put two "Retry connection" buttons on screen at once
   * (and made the cluster-unavailable e2e flaky on a strict-mode violation).
   */
  get connectionLost(): boolean {
    return this.connectionStatus === "error" && !this.isSwitchingContext;
  }
  override switchingContextTo = $state<string | null>(null);
  override isLoading = $state<boolean>(false);
  override error = $state<string | null>(null);
  override contextsLoadError = $state<string | null>(null);
  override namespacesLoadError = $state<string | null>(null);
  override resourceCounts = $state<Record<string, number>>({});
  override portForwards = $state<PortForwardInfo[]>([]);
  override ageTick = $state(0);
  override viewLoaded = $state(false);

  // CRD state
  override crdGroups = $state<CrdGroup[]>([]);
  // $state.raw: CRD payloads are arbitrary, often-large JSON shown in a
  // non-virtualized table — deep-proxying them is the worst offender. Replaced
  // wholesale, never field-mutated, so raw is both faster and correct.
  override crdResources = $state.raw<CrdResourceList>({ items: [], columns: [] });
  override crdLoading = $state<boolean>(false);
  override crdDiscovered = $state<boolean>(false);
  override crdError = $state<string | null>(null);
  override crdCounts = $state<Record<string, number>>({});
  override selectedCrd = $state<CrdInfo | null>(null);

  // Private members that require backend / browser APIs (not in logic class)
  private _ageInterval: ReturnType<typeof setInterval> | null = null;
  private _watchUnlisten: UnlistenFn | null = null;
  private _watchActive = false;
  private _pfUnlisten: UnlistenFn | null = null;
  // Pending watch deltas, COALESCED BY uid. _flushWatchEvents is a last-write-
  // wins upsert per uid, so keeping only the newest event per resource yields
  // exactly the same result as replaying every event — while bounding the buffer
  // to the number of distinct resources instead of the number of events.
  //
  // That bound is what makes a backgrounded window safe: the main process keeps
  // emitting every 50ms (electron/handlers/watch.ts WATCH_FLUSH_INTERVAL_MS)
  // while the renderer's flush is throttled, so an append-only buffer would grow
  // for as long as the window stays hidden and then land as one huge flush.
  //
  // Ordering: a replay appends a resource at the position of the event that
  // (re)introduced it, so a uid whose pending Deleted is later superseded by an
  // Applied must move to the END rather than keep the Deleted's slot.
  // `reinserted` records that transition and the flush honours it. Every other
  // case keeps the uid's existing position, matching a replay exactly.
  private _pendingWatchEvents = new Map<string, PendingWatchEvent>();
  /** Cancels the scheduled flush; null when no flush is pending. */
  private _cancelWatchFlush: (() => void) | null = null;
  // Serializes start/stop so two fire-and-forget callers can't race on the
  // single _ageInterval/_watchUnlisten/_watchActive slots and orphan a timer
  // or listener (a slow, unbounded leak under rapid type/tab switching).
  private _watchOp: Promise<void> = Promise.resolve();

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
      const message = `Failed to load contexts: ${errMsg(err)}`;
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
      const message = `Failed to load namespaces: ${errMsg(err)}`;
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

      this._clearEditorCaches();
      this._resetVisibleState({ clearNamespaces: true });
      this.currentContext = context;
      await this.loadNamespaces(scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;

      // Never fall back to "" — that lists at CLUSTER scope, which restrictive
      // RBAC forbids (403 on every list) and the namespace picker can't leave.
      const fallbackNamespace = this.namespaces.includes(this.currentNamespace)
        ? this.currentNamespace
        : this.namespaces.includes("default")
          ? "default"
          : (this.namespaces[0] ?? "default");
      this.currentNamespace = fallbackNamespace;

      await this.loadResources(this.selectedResourceType, scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;
      this.connectionStatus = "connected";
      this._persistSelection();
      // Refresh sidebar counts in background for new context
      void this.loadAllResourceCounts(scopeGeneration);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to switch context: ${errMsg(err)}`;
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
      this.error = `Failed to switch namespace: ${errMsg(err)}`;
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
      this._startWatch(resourceType, this.currentNamespace, result.resource_version);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to load resources: ${errMsg(err)}`;
      this.resources = { items: [], resource_type: resourceType };
    } finally {
      clearTimeout(timer);
      if (scopeGeneration === this._scopeGeneration) {
        this.isLoading = false;
        // First list for this view finished (either way): the table may now
        // legitimately show its empty/error states instead of "loading".
        this.viewLoaded = true;
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

  /**
   * Re-select a resource by reference (Kind OR plural type) + name and set it as
   * the selected resource. Used to re-hydrate a restored detail/logs/yaml tab on
   * cold boot — its selectedResource is ephemeral and was never persisted, so
   * the view would otherwise render blank.
   *
   * A detail tab stores resourceType as either the Kind ("Pod", when opened from
   * the table) or the plural ("pods", from related-resource nav), so we try the
   * targeted get_resource path (Kind form) first, then fall back to a list+find
   * (plural form). Returns true if a resource was selected.
   */
  async selectResourceByRef(typeOrKind: string, name: string, namespace?: string): Promise<boolean> {
    const found = await this.resolveResourceByRef(typeOrKind, name, namespace);
    if (found) {
      this.selectedResource = found;
      return true;
    }
    return false;
  }

  /**
   * Fetch a resource by reference WITHOUT touching the selection — callers that
   * re-hydrate a background tab decide themselves whether the result may become
   * the visible selectedResource (the user may have switched tabs meanwhile).
   */
  async resolveResourceByRef(typeOrKind: string, name: string, namespace?: string): Promise<Resource | null> {
    try {
      const full = await invoke<Resource>("get_resource", {
        kind: typeOrKind,
        name,
        namespace: namespace ?? "",
      });
      if (full) return full;
    } catch {
      // Not a Kind alias (e.g. a plural type) or the object is gone — try listing.
    }
    try {
      // The fallback lists by PLURAL type — normalize a Kind ("Deployment")
      // to its plural ("deployments") or list_resources rejects it outright.
      return await this.fetchResource(resourceTypeForRef(typeOrKind), name, namespace);
    } catch {
      // Unknown type or list failed — leave selection unset (view shows empty).
    }
    return null;
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
      this._startWatch(entry.resourceType, this.currentNamespace, result.resource_version);
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
      this._startWatch(expectedType, this.currentNamespace, result.resource_version);
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

  /** Load counts for all resource types via a single batch command. */
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
        this._clearEditorCaches();
        this.currentContext = context;
        this.connectionStatus = "connected";
      }
      if (namespace) {
        this.currentNamespace = namespace;
      }
    } catch (err) {
      this.error = `Failed to restore connection: ${errMsg(err)}`;
      this.connectionStatus = "error";
    }
  }

  /**
   * Drop the YAML editor's per-cluster caches. Both hold names and schemas that
   * belong to the previous apiserver: without this they survive until their TTL
   * expires and the editor suggests objects that do not exist here.
   */
  private _clearEditorCaches(): void {
    clearOpenApiCache();
    clearClusterCompletionCache();
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

  private _startWatch(resourceType: string, namespace: string, resourceVersion?: string): Promise<void> {
    // Chain onto the shared op so a stop always completes before the next start
    // runs — no two starts can interleave on the single interval/listener slots.
    this._watchOp = this._watchOp.then(async () => {
      await this._stopWatchInner();
      // Start age ticker every 30s to refresh displayed ages (1s is wasteful – age labels barely change)
      this._ageInterval = setInterval(() => { this.ageTick++; }, 30_000);
      try {
        // Listen for watch events from the backend
        this._watchUnlisten = await listen<import("./k8s.logic.js").WatchEvent | import("./k8s.logic.js").WatchEvent[]>("resource-watch-event", (event) => {
          this._handleWatchEvents(event.payload);
        });
        // Start the backend watcher. Passing the list's resourceVersion lets it
        // resume from what we just rendered instead of replaying every item.
        await invoke("start_resource_watch", {
          resourceType,
          namespace,
          resourceVersion: resourceVersion ?? null,
        });
        this._watchActive = true;
      } catch (err) {
        if (import.meta.env.DEV) console.warn("Failed to start resource watch:", err);
      }
    });
    return this._watchOp;
  }

  private _stopWatch(): Promise<void> {
    this._watchOp = this._watchOp.then(() => this._stopWatchInner());
    return this._watchOp;
  }

  private async _stopWatchInner(): Promise<void> {
    this._discardPendingWatchEvents();
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

  /** Backend may emit a single event or a coalesced batch (array). */
  private _handleWatchEvents(payload: import("./k8s.logic.js").WatchEvent | import("./k8s.logic.js").WatchEvent[]): void {
    if (Array.isArray(payload)) {
      for (const event of payload) this._handleWatchEvent(event);
    } else {
      this._handleWatchEvent(payload);
    }
  }

  private _handleWatchEvent(event: import("./k8s.logic.js").WatchEvent): void {
    // Only process events for the currently viewed resource type
    if (event.resource_type !== this.selectedResourceType) return;

    // Resync: watcher reconnected after a gap, do a full refresh
    if (event.event_type === "Resync") {
      this._discardPendingWatchEvents();
      this._refreshAfterResync();
      return;
    }

    // Events without a uid can never be applied (the flush keys on it), so drop
    // them here rather than buffering something the flush would skip anyway.
    const uid = event.resource.metadata?.uid;
    if (!uid) return;

    // Coalesce: the newest event for a uid supersedes any earlier pending one.
    // set() keeps the existing key's position, which is what a replay does for
    // an in-place update. The exception is Deleted -> Applied: a replay removes
    // the row and re-appends it, so drop the key first to move it to the end
    // and flag it so the flush repositions the live row too.
    const prev = this._pendingWatchEvents.get(uid);
    const reinserted = prev?.event.event_type === "Deleted" && event.event_type === "Applied";
    if (reinserted) this._pendingWatchEvents.delete(uid);
    this._pendingWatchEvents.set(uid, {
      event,
      reinserted: reinserted || (prev?.reinserted ?? false),
    });

    if (!this._cancelWatchFlush) {
      // NOT a bare requestAnimationFrame: rAF is paused while the window is
      // minimized or occluded, which would strand the buffer until refocus.
      this._cancelWatchFlush = scheduleFlush(() => this._flushWatchEvents());
    }
  }

  /** Drop every buffered delta and cancel any scheduled flush. */
  private _discardPendingWatchEvents(): void {
    this._pendingWatchEvents.clear();
    this._cancelWatchFlush?.();
    this._cancelWatchFlush = null;
  }

  private _flushWatchEvents(): void {
    // [uid, event] pairs — the uid is the map key, already validated on enqueue.
    const batch = [...this._pendingWatchEvents];
    this._pendingWatchEvents.clear();
    this._cancelWatchFlush = null;

    if (batch.length === 0) return;

    // Guard: discard stale events if context/namespace changed during the frame
    const scopeGen = this._scopeGeneration;

    // Build an ordered uid→Resource map once (O(N)) so each event is an O(1)
    // upsert/delete instead of an O(N) findIndex/splice — turns the worst-case
    // O(N·M) flush (M events over N items) into O(N+M). Map iteration order
    // matches the current array and set() keeps an existing key's position, so
    // an update lands in place; only a `reinserted` uid moves (see below).
    // A fresh array is built at the end (required for $state.raw correctness).
    const byUid = new Map<string, Resource>();
    for (const r of this.resources.items) {
      const uid = r.metadata?.uid;
      if (uid) byUid.set(uid, r);
    }

    let selectedResourceUpdate: Resource | null | undefined;
    let changed = false;

    // Which numbers, if any, this table wants highlighted when they move. Null
    // for almost every resource type, and resolving it once here is what keeps
    // the flush free of per-event cost for the types that do not opt in.
    const signals = signalsFor(this.selectedResourceType);
    const now = signals ? Date.now() : 0;

    for (const [uid, { event, reinserted }] of batch) {
      // Double-check scope hasn't changed mid-flush
      if (this._scopeGeneration !== scopeGen) return;

      if (event.event_type === "Applied") {
        // Same resourceVersion = identical object (k8s bumps RV on every
        // change): the event is a replay (initial watch sync / reconnect),
        // not a delta. Skipping it avoids re-rendering the whole table once
        // per replayed batch right after navigation/restore.
        //
        // Not applicable to a reinserted uid: a replay would have deleted and
        // re-appended the row, so its POSITION changes even when its content
        // does not, and skipping would leave the row where it was.
        const prev = byUid.get(uid);
        const rv = event.resource.metadata?.resource_version;
        if (!reinserted && prev && rv && prev.metadata?.resource_version === rv) continue;
        // Deleted -> Applied within the batch: drop the old key so set() appends
        // at the end, exactly where a replay would have put it.
        // The flush is the only place holding the old and the new object at
        // once, so it is the only place that can say which way a value moved.
        if (signals && prev) liveValues.compare(uid, signals(prev), signals(event.resource), now);
        if (reinserted) byUid.delete(uid);
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
      // Trigger Svelte 5 reactivity ONCE for the entire batch
      this.resources = { items, resource_type: this.resources.resource_type };
      this._setCount(this.selectedResourceType, items.length);
    }

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
      this.error = `Failed to start port forward: ${errMsg(err)}`;
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
      this.crdDiscovered = true;
    } catch (e) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdError = String(e);
      this.crdGroups = [];
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
