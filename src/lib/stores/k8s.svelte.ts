import { invoke } from "$lib/ipc/core";
import { listen, type UnlistenFn } from "$lib/ipc/event";
import type { Resource, ResourceList, ConnectionStatus, PortForwardInfo, CrdGroup, CrdInfo, CrdColumn, CrdResourceList } from "../types/index.js";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte.js";
import {
  K8sStoreLogic,
  COUNTABLE_RESOURCE_TYPES,
  crdTypeFor,
  parseCrdType,
  isWatchNotice,
  type WatchPayload,
} from "./k8s.logic.js";
import { resourceTypeForRef } from "$lib/utils/related-resources";
import { clearClusterCompletionCache } from "$lib/utils/cluster-completion-source";
import { clearOpenApiCache } from "$lib/utils/openapi-schema";
import { scheduleFlush } from "$lib/utils/frame-scheduler";
import { liveValues, signalsFor } from "./live-values.svelte";
import { unshadowState } from "./_unshadow.js";

export type { WatchEvent, WatchNotice, NavigationEntry } from "./k8s.logic.js";
export { COUNTABLE_RESOURCE_TYPES, crdTypeFor, parseCrdType } from "./k8s.logic.js";

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

/** A listing as the store consumes it: a CRD listing also carries its printer columns. */
interface ListedResources extends ResourceList {
  columns?: CrdColumn[];
}

/** While unreachable, ask the cluster again this often (a cheap namespaces list). */
const REACHABILITY_PROBE_MS = 15_000;

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
  override lastUpdatedAt = $state(0);
  override watching = $state(false);
  override reachable = $state(true);
  override unreachableSince = $state(0);
  override lastHeartbeatAt = $state(0);

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
  // uid → Resource index of `resources.items`, kept between watch flushes so a
  // batch of M events costs O(M), not O(N+M). `_byUidItems` records which
  // array it describes: any other writer replacing the list (refresh, tab
  // switch) makes it stale and it is rebuilt on the next flush. Dropped — not
  // kept stale — on replacement so it never pins a list the store let go of.
  private _byUid: Map<string, Resource> | null = null;
  private _byUidItems: Resource[] | null = null;
  /** Cancels the scheduled flush; null when no flush is pending. */
  private _cancelWatchFlush: (() => void) | null = null;
  // Serializes start/stop so two fire-and-forget callers can't race on the
  // single _ageInterval/_watchUnlisten/_watchActive slots and orphan a timer
  // or listener (a slow, unbounded leak under rapid type/tab switching).
  private _watchOp: Promise<void> = Promise.resolve();
  // In-flight loads keyed by scope + type + namespace. Opening a CRD table
  // asks for the same list twice within a tick (the sidebar click and the
  // tab-switch hook), and each load restarts the watch — the second caller
  // now joins the first instead.
  private _inflightLoads = new Map<string, Promise<void>>();
  /** Reachability probe timer; armed only while `reachable` is false. */
  private _probeTimer: ReturnType<typeof setTimeout> | null = null;

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
      const result = await this._tracked(invoke<string[]>("get_namespaces"));
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

      // Never fall back to "" by accident — that lists at CLUSTER scope, which
      // restrictive RBAC forbids (403 on every list). "" chosen on purpose
      // ("All namespaces" in the picker) is kept: the picker can leave it.
      const fallbackNamespace =
        this.currentNamespace === "" || this.namespaces.includes(this.currentNamespace)
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
    // Switching while the cluster is gone used to neither error nor apply:
    // the list hung until the cluster came back, then landed on whatever the
    // user had since moved on to. Refuse up front and say so.
    if (!this.reachable) {
      toastStore.error(
        "Cluster unreachable — cannot switch namespace",
        `${this.unreachableTooltip}. Retry from the banner once the cluster is back.`,
      );
      return;
    }
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

  loadResources(resourceType: string, scopeGeneration = this._scopeGeneration): Promise<void> {
    const key = `${scopeGeneration}|${resourceType}|${this.currentNamespace}`;
    const inflight = this._inflightLoads.get(key);
    if (inflight) return inflight;
    const run = this._loadResources(resourceType, scopeGeneration).finally(() => {
      if (this._inflightLoads.get(key) === run) this._inflightLoads.delete(key);
    });
    this._inflightLoads.set(key, run);
    return run;
  }

  private async _loadResources(resourceType: string, scopeGeneration: number): Promise<void> {
    const timer = setTimeout(() => { this.isLoading = true; }, 200);
    try {
      this.error = null;
      this.pendingResourceType = resourceType;
      const result = await this._listResources(resourceType);
      if (scopeGeneration !== this._scopeGeneration) return;
      if (this.pendingResourceType !== resourceType) return;
      this.selectedResourceType = resourceType;
      if (result.columns) this._adoptCrdListing(resourceType, result.items, result.columns);
      this._replaceResources(result, Date.now());
      this._setCount(resourceType, result.items.length);
      this._startWatch(resourceType, this.currentNamespace, result.resource_version);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to load resources: ${errMsg(err)}`;
      this._replaceResources({ items: [], resource_type: resourceType }, 0);
      // The CRD table has no error state of its own — it shows "No X found"
      // for an empty list — so the failure is said out loud there.
      if (parseCrdType(resourceType)) toastStore.error("Failed to load CRD resources", errMsg(err));
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

  /**
   * One object by Kind, or null when it does not exist. Any other failure
   * (RBAC, network) throws — callers that poll must tell "gone" from "could
   * not ask" apart.
   */
  async getResource(kind: string, name: string, namespace?: string): Promise<Resource | null> {
    try {
      return await invoke<Resource>("get_resource", { kind, name, namespace: namespace ?? "" });
    } catch (err) {
      if (/not found|404/i.test(errMsg(err))) return null;
      throw err;
    }
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
      this._replaceResources(result, Date.now());
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
      this._replaceResources(result, Date.now());
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
      const counts = await this._tracked(
        invoke<Record<string, number>>("get_resource_counts", {
          resourceTypes: [...COUNTABLE_RESOURCE_TYPES],
          namespace,
        }),
      );
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

  private async _listResources(resourceType: string): Promise<ListedResources> {
    const crdRef = parseCrdType(resourceType);
    if (!crdRef) {
      return this._tracked(
        invoke<ResourceList>("list_resources", { resourceType, namespace: this.currentNamespace }),
      );
    }
    // A `crd:` pseudo-type lists through the CRD handler — list_resources only
    // knows built-in kinds and used to log "Unknown resource type: crd:…" for
    // every CRD tab the tab lifecycle (re)loaded.
    let crd = this.findCrd(crdRef.group, crdRef.kind);
    if (!crd && !this.crdDiscovered && !this.crdLoading) {
      // A CRD tab restored before the sidebar's discovery ran: discover now
      // rather than fail on a kind the cluster may well serve.
      await this.discoverCrds();
      crd = this.findCrd(crdRef.group, crdRef.kind);
    }
    if (!crd) {
      throw new Error(`Custom resource ${crdRef.group}/${crdRef.kind} is not known in this cluster`);
    }
    const result = await this._tracked(
      invoke<CrdResourceList & { resource_version?: string }>("list_crd_resources", {
        group: crd.group,
        version: crd.version,
        kind: crd.kind,
        plural: crd.plural,
        scope: crd.scope,
        namespace: crd.scope === "Namespaced" ? this.currentNamespace : null,
      }),
    );
    const out: ListedResources = { items: result.items, resource_type: resourceType, columns: result.columns };
    if (result.resource_version) out.resource_version = result.resource_version;
    return out;
  }

  // ---------------------------------------------------------------------
  // Reachability. Every call that goes to the apiserver passes through
  // _tracked: success is a heartbeat, a transport failure starts an outage.
  // ---------------------------------------------------------------------

  private async _tracked<T>(call: Promise<T>): Promise<T> {
    try {
      const result = await call;
      this._onReachable();
      return result;
    } catch (err) {
      this.noteCallFailure(errMsg(err));
      throw err;
    }
  }

  /** Heartbeat; on the transition back from an outage, reload the view and restart its watch. */
  private _onReachable(): void {
    if (!this._markReachable()) return;
    this._stopProbe();
    toastStore.success("Cluster reachable again", `Reloading ${this.selectedResourceType}`);
    void this.loadResources(this.selectedResourceType);
    void this.loadAllResourceCounts();
  }

  override _markUnreachable(now: number = Date.now()): void {
    super._markUnreachable(now);
    this._armProbe();
  }

  /**
   * With no live watch (its start failed too) nothing would ever notice the
   * cluster coming back. Poll a cheap call until it answers; _tracked flips
   * the state and stops the probe.
   */
  private _armProbe(): void {
    if (this._probeTimer || this.reachable) return;
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      if (this.reachable) return;
      this._tracked(invoke<string[]>("get_namespaces"))
        .then((nss) => { this.namespaces = nss; })
        .catch(() => this._armProbe());
    }, REACHABILITY_PROBE_MS);
  }

  private _stopProbe(): void {
    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
    }
  }

  /** Retry from the outage banner: the same recovery the boot overlay runs. */
  async retryConnection(): Promise<void> {
    await this.loadContexts();
    if (this.connectionStatus !== "connected") return;
    await this.loadNamespaces();
    await this.loadResources(this.selectedResourceType);
    void this.loadAllResourceCounts();
  }

  private _startWatch(resourceType: string, namespace: string, resourceVersion?: string): Promise<void> {
    // Chain onto the shared op so a stop always completes before the next start
    // runs — no two starts can interleave on the single interval/listener slots.
    this._watchOp = this._watchOp.then(async () => {
      await this._stopWatchInner();
      // Start age ticker every 30s to refresh displayed ages (1s is wasteful – age labels barely change)
      // Skipped while the window is hidden: nothing is painted, and each tick
      // re-renders every visible row's age cells. The first tick after the
      // window comes back refreshes them, so nothing is lost.
      this._ageInterval = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        this.ageTick++;
      }, 30_000);
      try {
        // Listen for watch events from the backend
        this._watchUnlisten = await listen<WatchPayload | WatchPayload[]>("resource-watch-event", (event) => {
          this._handleWatchEvents(event.payload);
        });
        // Start the backend watcher. Passing the list's resourceVersion lets it
        // resume from what we just rendered instead of replaying every item.
        await this._tracked(
          invoke("start_resource_watch", {
            resourceType,
            namespace,
            resourceVersion: resourceVersion ?? null,
          }),
        );
        this._watchActive = true;
        this.watching = true;
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
    this.watching = false;
    if (this._watchUnlisten) {
      this._watchUnlisten();
      this._watchUnlisten = null;
    }
  }

  /** Backend may emit a single event or a coalesced batch (array). */
  private _handleWatchEvents(payload: WatchPayload | WatchPayload[]): void {
    if (Array.isArray(payload)) {
      for (const event of payload) this._handleWatchEvent(event);
    } else {
      this._handleWatchEvent(payload);
    }
  }

  private _handleWatchEvent(event: WatchPayload): void {
    // Only process events for the currently viewed resource type
    if (event.resource_type !== this.selectedResourceType) return;

    // Lifecycle notices: a stream that died (watching=false, and an outage if
    // the failure was transport-level) or one that came back. A watch_open
    // that ends an outage reloads the view through _onReachable — the backend
    // resumed the stream, but the rows on screen are from before the outage.
    if (isWatchNotice(event)) {
      if (event.event_type === "watch_open") {
        this.watching = true;
        this._onReachable();
      } else {
        this.handleWatchNotice(event);
      }
      return;
    }

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
  override _replaceResources(list: ResourceList, at: number): void {
    if (this._byUidItems !== list.items) {
      this._byUid = null;
      this._byUidItems = null;
    }
    super._replaceResources(list, at);
  }

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

    // Ordered uid→Resource map so each event is an O(1) upsert/delete instead
    // of an O(N) findIndex/splice. Map iteration order matches the current
    // array and set() keeps an existing key's position, so an update lands in
    // place; only a `reinserted` uid moves (see below). The map survives
    // between flushes (see _byUid): building it is the only O(N) step, and a
    // rollout on a 5k-pod list used to pay it once per frame for batches of
    // one event. A fresh array is still built at the end (required for
    // $state.raw correctness).
    let byUid: Map<string, Resource>;
    if (this._byUid && this._byUidItems === this.resources.items) {
      byUid = this._byUid;
    } else {
      byUid = new Map<string, Resource>();
      for (const r of this.resources.items) {
        const uid = r.metadata?.uid;
        if (uid) byUid.set(uid, r);
      }
    }
    // Checked out for the duration of the batch: an early return below (scope
    // changed mid-flush) leaves a half-applied map, which must not be reused.
    this._byUid = null;
    this._byUidItems = null;

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
      this._replaceResources({ items, resource_type: this.resources.resource_type }, Date.now());
      this._setCount(this.selectedResourceType, items.length);
      this._byUidItems = items;
    } else {
      this._byUidItems = this.resources.items;
    }
    this._byUid = byUid;

    if (selectedResourceUpdate !== undefined) {
      this.selectedResource = selectedResourceUpdate;
    }
  }

  private async _refreshAfterResync(): Promise<void> {
    try {
      const result = await this._listResources(this.selectedResourceType);
      this._replaceResources(result, Date.now());
      this._setCount(this.selectedResourceType, result.items.length);
    } catch (err) {
      if (import.meta.env.DEV) console.warn("Failed to refresh after resync:", err);
    }
  }

  /** Start a session; throws with the backend's message on failure. */
  async startPortForward(info: PortForwardInfo): Promise<PortForwardInfo> {
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
    const started = { ...info, local_port: result.local_port, session_id: result.session_id };
    this.portForwards = [...this.portForwards, started];
    return started;
  }

  /** Like startPortForward, but reports failure through `error` (detail panels read it). */
  async addPortForward(info: PortForwardInfo): Promise<void> {
    try {
      await this.startPortForward(info);
    } catch (err) {
      this.error = `Failed to start port forward: ${errMsg(err)}`;
    }
  }

  /** Forget a session the backend reported closed; returns it so the caller can explain. */
  dropPortForward(sessionId: string): PortForwardInfo | undefined {
    const pf = this.portForwards.find((p) => p.session_id === sessionId);
    if (pf) this.portForwards = this.portForwards.filter((p) => p.session_id !== sessionId);
    return pf;
  }

  /** Link (or unlink) an active session to a saved forward. */
  adoptPortForward(sessionId: string, savedId: string | undefined): void {
    this.portForwards = this.portForwards.map((pf) =>
      pf.session_id === sessionId ? { ...pf, saved_id: savedId } : pf,
    );
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

  /**
   * Open a CRD table: the listing goes through loadResources under the
   * `crd:<group>/<Kind>` pseudo-type, so the tab lifecycle, the cache restore
   * and the live watch treat it exactly like a built-in kind.
   */
  async loadCrdResources(crd: CrdInfo): Promise<void> {
    const type = crdTypeFor(crd);
    this.selectedCrd = crd;
    this.crdResources = { items: [], columns: this._crdColumns.get(type) ?? [] };
    this.setResourceType(type);
    await this.loadResources(type);
  }

  private _crdCountsInFlight = new Set<string>();
  async loadCrdCounts(requested: CrdInfo[]): Promise<void> {
    // A CRD whose count is already being fetched is not requested again: the
    // sidebar effect re-runs on every partial result and would otherwise
    // re-issue the whole remaining set each time.
    const crds = requested.filter((crd) => !this._crdCountsInFlight.has(this.crdKey(crd)));
    if (crds.length === 0) return;
    const keys = crds.map((crd) => this.crdKey(crd));
    for (const key of keys) this._crdCountsInFlight.add(key);
    try {
      const counts = await this._tracked(
        invoke<Record<string, number>>("get_crd_counts", {
          crds,
          namespace: this.currentNamespace,
        }),
      );
      this.crdCounts = { ...this.crdCounts, ...counts };
    } catch {
      // Silently fail — counts are non-essential
    } finally {
      for (const key of keys) this._crdCountsInFlight.delete(key);
    }
  }
}

export type { K8sStore };
export const k8sStore = new K8sStore();
