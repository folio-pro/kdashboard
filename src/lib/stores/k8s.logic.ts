import type {
  Resource,
  ResourceList,
  ConnectionStatus,
  PortForwardInfo,
  CrdGroup,
  CrdInfo,
  CrdColumn,
  CrdResourceList,
} from "../types/index.js";
import { LISTABLE_RESOURCE_TYPES } from "../resource-catalog.js";

export interface WatchEvent {
  event_type: "Applied" | "Deleted" | "Resync";
  resource_type: string;
  resource: Resource;
}

/**
 * A watch lifecycle notice, on the same channel as the deltas. `watch_error`
 * says the backend stream ended with an error and is reconnecting with
 * backoff; `watch_open` says a reconnect after such an error succeeded. The
 * store uses them to tell "the cluster went away mid-session" from "the
 * apiserver closed a stream on schedule" — the latter carries no notice.
 */
export interface WatchNotice {
  event_type: "watch_error" | "watch_open";
  resource_type: string;
  message?: string;
}

export type WatchPayload = WatchEvent | WatchNotice;

export function isWatchNotice(payload: WatchPayload): payload is WatchNotice {
  return payload.event_type === "watch_error" || payload.event_type === "watch_open";
}

/**
 * Pseudo resource_type for a custom resource: `crd:<group>/<Kind>`. Tabs and
 * the sidebar have always used it; the backend now resolves it too, so a CRD
 * table lists and watches through the same paths as a built-in kind.
 */
export const CRD_TYPE_PREFIX = "crd:";

export function crdTypeFor(crd: { group: string; kind: string }): string {
  return `${CRD_TYPE_PREFIX}${crd.group}/${crd.kind}`;
}

export function parseCrdType(resourceType: string): { group: string; kind: string } | null {
  if (!resourceType.startsWith(CRD_TYPE_PREFIX)) return null;
  const rest = resourceType.slice(CRD_TYPE_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { group: rest.slice(0, slash), kind: rest.slice(slash + 1) };
}

/**
 * Does a failed invoke mean the CLUSTER is gone, rather than one call being
 * refused? Only the backend's Error.message crosses IPC, so this matches the
 * shapes electron/k8s/errors.ts produces for transport failures (the bracketed
 * code, "Cannot reach …", undici's "fetch failed" / "Request to … failed"),
 * Node's raw socket errors, and an apiserver answering 5xx. RBAC 403s, 404s
 * and validation errors are deliberately NOT here: the cluster answered.
 */
const NETWORK_ERROR_PATTERNS: RegExp[] = [
  /\b(ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE)\b/,
  /\bUND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET)\b/,
  /^Cannot reach /,
  /^Request to .* failed/,
  /fetch failed/i,
  /socket hang up/i,
  /HTTP-Code: 5\d\d/,
  /\b(service unavailable|bad gateway|gateway time-?out|internal server error)\b/i,
];

export function isNetworkErrorMessage(message: string): boolean {
  return NETWORK_ERROR_PATTERNS.some((re) => re.test(message));
}

/** Local wall-clock "HH:MM" for a timestamp — the tooltips' unit of staleness. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
  /**
   * Whether the cluster answered the last call we made. Independent of
   * `connectionStatus` ("error" there is the boot-time failure that takes the
   * whole window; this is the mid-session outage that must NOT). Flipped off
   * by a network-class failure or a watch_error, back on by the next call
   * that succeeds or a watch_open.
   */
  reachable: boolean = true;
  /** Epoch ms of the failure that flipped `reachable` off; 0 while reachable. */
  unreachableSince: number = 0;
  /** Epoch ms of the last call the cluster answered. 0 = never. */
  lastHeartbeatAt: number = 0;

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
  /**
   * Printer columns per CRD pseudo-type, kept across tab switches: a CRD tab
   * restored from its cache carries only the rows, and the columns came with
   * the listing that filled it.
   */
  protected _crdColumns = new Map<string, CrdColumn[]>();

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
    this._crdColumns.clear();

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
    // A CRD table reads `crdResources`; keep its rows in step with every
    // writer of `resources` (list, watch delta, cache restore) so live updates
    // reach it without a second code path. Reassigned, never mutated: raw state.
    if (parseCrdType(list.resource_type) && this.crdResources.items !== list.items) {
      this.crdResources = { items: list.items, columns: this.crdResources.columns };
    }
  }

  /** Restore resources from tab cache without fetching */
  restoreResourcesSync(resourceType: string, items: Resource[]): void {
    this._scopeGeneration++;
    this.setResourceType(resourceType);
    const crdRef = parseCrdType(resourceType);
    if (crdRef) {
      this.selectedCrd = this.findCrd(crdRef.group, crdRef.kind) ?? this.selectedCrd;
      this.crdResources = { items, columns: this._crdColumns.get(resourceType) ?? [] };
    }
    this._replaceResources({ items, resource_type: resourceType }, 0);
    this._setCount(resourceType, items.length);
    this.isLoading = false;
    this.error = null;
    this.viewLoaded = true;
  }

  /** Adopt a CRD listing: rows, printer columns, and the columns cache for later restores. */
  _adoptCrdListing(resourceType: string, items: Resource[], columns: CrdColumn[]): void {
    this._crdColumns.set(resourceType, columns);
    this.crdResources = { items, columns };
  }

  /** The discovered CRD behind a `crd:` pseudo-type, if discovery has seen it. */
  findCrd(group: string, kind: string): CrdInfo | null {
    if (this.selectedCrd && this.selectedCrd.group === group && this.selectedCrd.kind === kind) {
      return this.selectedCrd;
    }
    for (const g of this.crdGroups) {
      if (g.group !== group) continue;
      const hit = g.resources.find((c) => c.kind === kind);
      if (hit) return hit;
    }
    return null;
  }

  // --- Reachability -------------------------------------------------------

  /** The cluster answered: note the heartbeat; returns true if this ended an outage. */
  _markReachable(now: number = Date.now()): boolean {
    this.lastHeartbeatAt = now;
    if (this.reachable) return false;
    this.reachable = true;
    this.unreachableSince = 0;
    return true;
  }

  /** A call failed because the cluster is gone: start (or continue) the outage. */
  _markUnreachable(now: number = Date.now()): void {
    if (!this.reachable) return;
    this.reachable = false;
    this.unreachableSince = now;
  }

  /**
   * Classify a failed invoke by its message: transport failures flip
   * `reachable` off; anything the cluster itself answered (403, 404, …) does
   * not. Returns whether the failure was counted as an outage.
   */
  noteCallFailure(message: string, now: number = Date.now()): boolean {
    if (!isNetworkErrorMessage(message)) return false;
    this._markUnreachable(now);
    return true;
  }

  /** "Cluster unreachable since HH:MM · showing data from HH:MM" — or "" while reachable. */
  get unreachableTooltip(): string {
    if (this.reachable) return "";
    const since = `Cluster unreachable since ${formatClock(this.unreachableSince)}`;
    const dataAt = this.lastUpdatedAt || this.lastHeartbeatAt;
    return dataAt ? `${since} · showing data from ${formatClock(dataAt)}` : since;
  }

  /** Watch lifecycle notice from the backend (same channel as the deltas). */
  handleWatchNotice(notice: WatchNotice, now: number = Date.now()): void {
    if (notice.resource_type !== this.selectedResourceType) return;
    if (notice.event_type === "watch_error") {
      this.watching = false;
      // A stream that died on the apiserver's schedule reconnects silently;
      // only a transport failure means the cluster itself is gone.
      if (notice.message) this.noteCallFailure(notice.message, now);
      return;
    }
    this.watching = true;
    this._markReachable(now);
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
  handleWatchEvent(event: WatchPayload): void {
    if (isWatchNotice(event)) {
      this.handleWatchNotice(event);
      return;
    }
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

  /** Is this type cluster-wide by nature — a cluster-scoped CRD? (Built-in kinds: see resource-catalog.) */
  isClusterScopedCrd(resourceType: string): boolean {
    const ref = parseCrdType(resourceType);
    if (!ref) return false;
    return this.findCrd(ref.group, ref.kind)?.scope === "Cluster";
  }
}
