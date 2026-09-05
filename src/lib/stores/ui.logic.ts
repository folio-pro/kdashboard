import type { SortDirection, Resource, Facet } from "../types/index.js";
import { dedupeFacets, facetKey } from "../utils/facets.js";

export type ActiveView = "table" | "details" | "logs" | "terminal" | "portforwards" | "yaml" | "settings" | "topology" | "cost" | "security" | "helm" | "crd-table" | "overview" | "problems";

/**
 *                    ┌───────────────────────────────────────┐
 *                    │  UiStoreLogic — single source of truth │
 *                    └───────────────────────────────────────┘
 *
 *  Global (store-level):     Per-tab (in `Tab`):
 *  ─────────────────────     ──────────────────────────
 *  sidebarCollapsed          filter            ──┐
 *  commandPaletteOpen        _debouncedFilter    │  getter/setter on
 *  activeView                sortColumn          │  UiStoreLogic reads
 *  previousView              sortDirection       │─ and writes
 *  tabs[]                    statFilter          │  `this.activeTab.*`
 *  activeTabId               selectedRows        │
 *                            selectedRowIndex  ──┘
 *                            cachedItems / cachedResource / count / cacheReady
 *                            namespace / resourceName / resourceType
 *
 *  Tab switch:
 *    activateTab(id) → flushDebounce() → swap activeTabId → getters now
 *    read the new tab's state. No explicit reset of filter/sort/etc — each
 *    tab owns its UI state and survives round-trips.
 */
/**
 * Box for a tab's cached resource list. A CLASS on purpose: `tabs` is deep
 * `$state`, and Svelte 5's proxy wraps plain objects/arrays it encounters —
 * assigning `k8sStore.resources.items` (deliberately `$state.raw`) straight
 * onto a tab would deep-proxy every cached resource, and restoring the tab
 * would feed that proxied array back into the raw store, re-paying per-field
 * Proxy/signal allocation on every filter/sort/render pass. Class instances
 * are exempt from Svelte's proxying, so the array inside stays raw.
 */
export class CachedItems {
  constructor(readonly items: Resource[]) {}
}

export interface Tab {
  id: string;
  type: ActiveView;
  label: string;
  icon?: string;
  closable: boolean;
  /** For resource-specific tabs (details, logs, terminal, yaml) */
  resourceName?: string;
  resourceType?: string;
  /** Namespace this tab was opened with */
  namespace?: string;
  /** Resource count for table/crd tabs */
  count?: number;
  /** Cached resource data — avoids reload on tab switch */
  cachedItems?: CachedItems;
  /** True once a load has completed for this tab; distinguishes a legitimately
   *  empty result from an in-flight/uninitialized load. */
  cacheReady?: boolean;
  /** Cached selected resource — restores detail/logs/yaml/terminal views on tab switch */
  cachedResource?: Resource;

  // Per-tab UI state. All optional — absent means "default" via getter fallback.
  /** Search filter text (free text; typed `key:value` terms live in `facets`). */
  filter?: string;
  /** Typed filter terms, each shown as a chip ahead of the search text. */
  facets?: Facet[];
  /** Debounced filter value (committed 150ms after last keystroke). */
  _debouncedFilter?: string;
  /** Active sort column. */
  sortColumn?: string;
  /** Active sort direction. */
  sortDirection?: SortDirection;
  /** Stat-card filter key (e.g. "running", "needsAttention"). */
  statFilter?: string | null;
  /** Selected row uids (ephemeral — not persisted across sessions). */
  selectedRows?: Set<string>;
  /** Keyboard-focused row index; -1 = no focus. */
  selectedRowIndex?: number;
  /** Table views: the detail aside is open for the selected resource (ephemeral). */
  previewOpen?: boolean;
  /** Detail views (and a table's aside): the DetailPanel sub-tab in use. Per
   *  tab, so a YAML editor left open in one detail never leaks into the next. */
  detailSubtab?: DetailSubtab;
}

const EMPTY_SELECTED_ROWS: Set<string> = new Set();
const EMPTY_FACETS: Facet[] = [];

/**
 * Sort column a tab starts on before the user picks one. Events lead with the
 * most recent activity (their table has no Name column to sort by); everything
 * else keeps the historical name sort.
 */
export function defaultSortColumn(tab: Tab | undefined | null): string {
  return tab?.resourceType === "events" ? "eventLastSeen" : "name";
}

let _tabCounter = 0;
function nextTabId(): string {
  return `tab-${++_tabCounter}`;
}

/** Reset the tab counter (useful in tests) */
export function resetTabCounter(): void {
  _tabCounter = 0;
}

/**
 * Bump the tab counter so the next generated id is strictly greater than
 * any already in use. Called after hydrating tabs from storage to prevent
 * collisions with restored ids like "tab-7".
 */
export function ensureTabCounterAbove(n: number): void {
  if (n > _tabCounter) _tabCounter = n;
}

/** View types that should only have one tab open at a time */
const SINGLETON_VIEWS = new Set<ActiveView>(["settings", "topology", "cost", "security", "portforwards", "helm", "overview", "problems"]);

/** View types tied to a specific resource (cache selectedResource on tab switch) */
export const RESOURCE_TAB_TYPES = new Set<ActiveView>(["details", "logs", "yaml", "terminal"]);

/** Canonical display labels for each view type */
export const VIEW_LABELS: Record<ActiveView, string> = {
  table: "Resources", details: "Detail",
  logs: "Logs", terminal: "Terminal", portforwards: "Port Forwards",
  yaml: "YAML", settings: "Settings",
  topology: "Topology", cost: "Cost", security: "Security",
  helm: "Helm Releases", "crd-table": "CRDs",
  overview: "Overview", problems: "Problems",
};

/** Fixed id (not "tab-N") so restored sessions and the tab counter never
 *  collide with the default tab. */
export const DEFAULT_TAB_ID = "tab-pods";
export const DEFAULT_RESOURCE_TYPE = "pods";

/** Default tab: the Pods table. */
export function mkPodsTab(): Tab {
  return { id: DEFAULT_TAB_ID, type: "table", label: "Pods", resourceType: DEFAULT_RESOURCE_TYPE, closable: true };
}

export type DetailSubtab = "overview" | "logs" | "shell" | "yaml" | "events";

export class UiStoreLogic {
  sidebarCollapsed = false;
  commandPaletteOpen = false;
  previousView: ActiveView | null = null;

  // Tab system
  tabs: Tab[] = [mkPodsTab()];
  activeTabId = "tab-pods";

  // Debounce timer lives on the store (single shared handle), but each
  // setFilter call captures its target tab in the closure so a fast
  // tab-switch doesn't misroute the deferred write.
  protected _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected _debounceTarget: Tab | null = null;

  // Memoized on (tabs array, index, id): every per-tab getter below goes
  // through here, and the table reads several of them per visible row per
  // render, so a linear scan over proxied tabs each time added up. Any
  // mutation that moves or replaces the tab fails the index check and falls
  // back to the scan; the reads still register the same reactive deps.
  #cachedTab: Tab | undefined;
  #cachedTabIdx = -1;
  get activeTab(): Tab | undefined {
    const id = this.activeTabId;
    const tabs = this.tabs;
    const cached = this.#cachedTab;
    if (cached && cached.id === id && tabs[this.#cachedTabIdx] === cached) return cached;
    const idx = tabs.findIndex((t) => t.id === id);
    this.#cachedTabIdx = idx;
    this.#cachedTab = idx >= 0 ? tabs[idx] : undefined;
    return this.#cachedTab;
  }

  /**
   * Which view is on screen. Derived, not stored: a tab's `type` IS its view,
   * so this was previously a second copy of `activeTab.type` that four
   * separate sites had to remember to keep in sync — including a bare
   * `uiStore.activeView = "table"` in the benchmark runner, which bypassed
   * the tab model entirely and is exactly where such a copy drifts.
   */
  get activeView(): ActiveView {
    return this.activeTab?.type ?? "table";
  }


  // ── Per-tab UI state (getter/setter over `this.activeTab`) ──
  // Defaults mirror the pre-refactor globals so consumers that never touched
  // a tab behave identically.

  get filter(): string {
    return this.activeTab?.filter ?? "";
  }
  set filter(v: string) {
    const t = this.activeTab;
    if (t) t.filter = v;
  }

  // Memoized: these getters are read per visible table row per render, and a
  // fresh toLowerCase() per read allocates on every one of those reads.
  #filterLowerSrc = "";
  #filterLowerVal = "";
  get filterLower(): string {
    const src = this.filter;
    if (src !== this.#filterLowerSrc) {
      this.#filterLowerSrc = src;
      this.#filterLowerVal = src.toLowerCase();
    }
    return this.#filterLowerVal;
  }

  #debouncedLowerSrc = "";
  #debouncedLowerVal = "";
  get debouncedFilterLower(): string {
    const src = this.activeTab?._debouncedFilter ?? "";
    if (src !== this.#debouncedLowerSrc) {
      this.#debouncedLowerSrc = src;
      this.#debouncedLowerVal = src.toLowerCase();
    }
    return this.#debouncedLowerVal;
  }

  get facets(): Facet[] {
    return this.activeTab?.facets ?? EMPTY_FACETS;
  }
  set facets(v: Facet[]) {
    const t = this.activeTab;
    if (t) t.facets = dedupeFacets(v);
  }

  /**
   * Append the facets not already on the tab. A facet's identity is key+op+
   * value; one batch can repeat itself (`ns:kube ns:kube`), so `seen` grows as
   * the batch is walked — the chip list is keyed by that identity.
   */
  addFacets(facets: Facet[]): void {
    const t = this.activeTab;
    if (!t || facets.length === 0) return;
    const seen = new Set((t.facets ?? []).map(facetKey));
    const fresh: Facet[] = [];
    for (const f of facets) {
      const k = facetKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(f);
    }
    if (fresh.length === 0) return;
    t.facets = [...(t.facets ?? []), ...fresh];
  }

  removeFacet(index: number): void {
    const t = this.activeTab;
    if (!t?.facets) return;
    t.facets = t.facets.filter((_, i) => i !== index);
  }

  /** Drop the last chip — what Backspace on an empty search box does. */
  popFacet(): Facet | undefined {
    const t = this.activeTab;
    if (!t?.facets?.length) return undefined;
    const last = t.facets[t.facets.length - 1];
    t.facets = t.facets.slice(0, -1);
    return last;
  }

  /**
   * Replace the tab's whole filter state at once — what applying a saved
   * view does. The debounced text is committed synchronously so the table
   * does not show the old text's results for a frame.
   */
  applyFilterState(state: { facets: Facet[]; text: string; statFilter: string | null }): void {
    const t = this.activeTab;
    if (!t) return;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
      this._debounceTarget = null;
    }
    t.facets = dedupeFacets(state.facets).map((f) => ({ ...f }));
    t.filter = state.text;
    t._debouncedFilter = state.text;
    t.statFilter = state.statFilter;
  }

  get sortColumn(): string {
    return this.activeTab?.sortColumn ?? defaultSortColumn(this.activeTab);
  }
  set sortColumn(v: string) {
    const t = this.activeTab;
    if (t) t.sortColumn = v;
  }

  get sortDirection(): SortDirection {
    return this.activeTab?.sortDirection ?? "asc";
  }
  set sortDirection(v: SortDirection) {
    const t = this.activeTab;
    if (t) t.sortDirection = v;
  }

  get statFilter(): string | null {
    return this.activeTab?.statFilter ?? null;
  }
  set statFilter(v: string | null) {
    const t = this.activeTab;
    if (t) t.statFilter = v;
  }

  get selectedRows(): Set<string> {
    return this.activeTab?.selectedRows ?? EMPTY_SELECTED_ROWS;
  }
  set selectedRows(v: Set<string>) {
    const t = this.activeTab;
    if (t) t.selectedRows = v;
  }

  get previewOpen(): boolean {
    return this.activeTab?.previewOpen ?? false;
  }
  set previewOpen(v: boolean) {
    const t = this.activeTab;
    if (t) t.previewOpen = v;
  }

  // Active sub-tab inside the resource DetailPanel (Overview/Logs/Shell/YAML/
  // Events). On the store so header buttons, keyboard shortcuts and the
  // command palette can switch it in place instead of opening a new top tab;
  // stored PER TAB so every freshly opened detail starts on Overview and a
  // tab keeps its sub-tab across switches.
  get detailSubtab(): DetailSubtab {
    return this.activeTab?.detailSubtab ?? "overview";
  }
  set detailSubtab(v: DetailSubtab) {
    const t = this.activeTab;
    if (t) t.detailSubtab = v;
  }

  get selectedRowIndex(): number {
    return this.activeTab?.selectedRowIndex ?? -1;
  }
  set selectedRowIndex(v: number) {
    const t = this.activeTab;
    if (t) t.selectedRowIndex = v;
  }

  openTab(type: ActiveView, opts?: { label?: string; resourceName?: string; resourceType?: string; namespace?: string; resource?: Resource }): void {
    // Singleton views: focus existing tab if open
    if (SINGLETON_VIEWS.has(type)) {
      const existing = this.tabs.find((t) => t.type === type);
      if (existing) {
        this.activateTab(existing.id);
        return;
      }
    }

    // Resource tabs: focus existing tab for same resource. Namespace is part
    // of the identity — same name+type in two namespaces are different
    // resources and must not share a tab.
    if (opts?.resourceName && opts?.resourceType) {
      const existing = this.tabs.find(
        (t) => t.type === type && t.resourceName === opts.resourceName &&
          t.resourceType === opts.resourceType && t.namespace === opts.namespace
      );
      if (existing) {
        if (opts.resource) existing.cachedResource = opts.resource;
        this.activateTab(existing.id);
        return;
      }
    }

    const label = opts?.label ?? this._defaultLabel(type);
    const tab: Tab = {
      id: nextTabId(),
      type,
      label,
      closable: true,
      resourceName: opts?.resourceName,
      resourceType: opts?.resourceType,
      namespace: opts?.namespace,
      // Seeded before activateTab so the tab-switch hook restores it into the
      // global selection instead of overwriting the OUTGOING tab's cache —
      // setting the selection before the switch poisoned the previous tab.
      cachedResource: opts?.resource,
    };
    this.tabs = [...this.tabs, tab];
    this.activateTab(tab.id);
  }

  /** Called synchronously before a tab switch — set by App.svelte to restore cached data */
  onBeforeTabSwitch: ((fromTab: Tab | undefined, toTab: Tab) => void) | null = null;

  activateTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const from = this.activeTab;
    // Restore data BEFORE changing the view — prevents empty state flash
    if (from?.id !== tab.id) {
      // Flush pending debounce against the OUTGOING tab so its filter and
      // _debouncedFilter stay consistent when we come back to it.
      this._flushDebounce();
      this.onBeforeTabSwitch?.(from, tab);
    }
    this.activeTabId = tabId;
    // activeView follows from tab.type — nothing to assign.
    // No reset of filter/sort/statFilter/selectedRows — each tab owns its state.
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.closable) return;
    const idx = this.tabs.indexOf(tab);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    // If no tabs left, reopen the default Pods table
    if (this.tabs.length === 0) {
      this.tabs = [mkPodsTab()];
      this.activateTab(DEFAULT_TAB_ID);
      return;
    }
    // If closing the active tab, activate the nearest one
    if (this.activeTabId === tabId) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.activateTab(this.tabs[newIdx].id);
    }
  }

  closeOtherTabs(tabId: string): void {
    this.tabs = this.tabs.filter((t) => t.id === tabId || !t.closable);
    this.activateTab(tabId);
  }

  closeTabsToTheLeft(tabId: string): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx <= 0) return;
    this.tabs = this.tabs.filter((t, i) => i >= idx || !t.closable);
    if (!this.tabs.find((t) => t.id === this.activeTabId)) {
      this.activateTab(tabId);
    }
  }

  closeTabsToTheRight(tabId: string): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    this.tabs = this.tabs.filter((t, i) => i <= idx || !t.closable);
    if (!this.tabs.find((t) => t.id === this.activeTabId)) {
      this.activateTab(tabId);
    }
  }

  closeAllTabs(): void {
    this.tabs = [mkPodsTab()];
    this.activateTab(DEFAULT_TAB_ID);
  }

  moveTab(tabId: string, direction: "left" | "right"): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const newIdx = direction === "left" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= this.tabs.length) return;
    const newTabs = [...this.tabs];
    [newTabs[idx], newTabs[newIdx]] = [newTabs[newIdx], newTabs[idx]];
    this.tabs = newTabs;
  }

  private _defaultLabel(type: ActiveView): string {
    return VIEW_LABELS[type] ?? type;
  }

  toggleRowSelection(uid: string): void {
    const t = this.activeTab;
    if (!t) return;
    const current = t.selectedRows ?? new Set<string>();
    const next = new Set(current);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    t.selectedRows = next;
  }

  selectAllRows(uids: string[]): void {
    const t = this.activeTab;
    if (!t) return;
    t.selectedRows = new Set(uids);
  }

  clearSelection(): void {
    const t = this.activeTab;
    if (!t) return;
    t.selectedRows = new Set();
  }

  get selectedCount(): number {
    return this.activeTab?.selectedRows?.size ?? 0;
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
  }

  toggleCommandPalette(): void {
    this.commandPaletteOpen = !this.commandPaletteOpen;
  }

  toggleSettings(): void {
    if (this.activeView === "settings") {
      this.backToPrevious();
    } else {
      this.showSettings();
    }
  }

  protected _switchView(view: ActiveView, opts?: { label?: string; resourceName?: string; resourceType?: string; namespace?: string; resource?: Resource }): void {
    this.previousView = this.activeView;
    this.openTab(view, opts);
  }

  showSettings(): void {
    this._switchView("settings");
  }

  showDetails(resourceName?: string, resourceType?: string, namespace?: string, resource?: Resource): void {
    this._switchView("details", {
      label: resourceName ?? "Detail",
      resourceName,
      resourceType,
      // Persisted with the tab: session restore re-fetches by (type, name,
      // namespace) — without the namespace a targeted get degrades to a
      // cluster-scope get (RBAC-fragile) or a wrong-namespace list.
      namespace,
      resource,
    });
  }

  showLogs(resourceName?: string): void {
    // When a resource detail is open, switch its sub-tab in place rather than
    // spawning a new top-level tab.
    if (this.activeView === "details") {
      this.detailSubtab = "logs";
      return;
    }
    this._switchView("logs", { label: resourceName ?? "Logs", resourceName });
  }

  showTerminal(resourceName?: string): void {
    if (this.activeView === "details") {
      this.detailSubtab = "shell";
      return;
    }
    this._switchView("terminal", { label: resourceName ?? "Terminal", resourceName });
  }

  showYamlEditor(resourceName?: string): void {
    if (this.activeView === "details") {
      this.detailSubtab = "yaml";
      return;
    }
    this._switchView("yaml", { label: resourceName ?? "YAML", resourceName });
  }

  showView(view: ActiveView): void {
    this._switchView(view);
  }

  backToTable(label?: string, resourceType?: string, namespace?: string): void {
    // Find existing tab for this resource type
    const existing = resourceType
      ? this.tabs.find((t) => t.type === "table" && t.resourceType === resourceType)
      : this.tabs.find((t) => t.type === "table");
    if (existing) {
      if (label) existing.label = label;
      this.activateTab(existing.id);
    } else {
      this.openTab("table", { label: label ?? "Resources", resourceType, namespace });
    }
  }

  updateActiveTabLabel(label: string): void {
    const tab = this.tabs.find((t) => t.id === this.activeTabId);
    if (tab) tab.label = label;
  }

  backToPrevious(): void {
    // Close current tab and go to the previous one
    if (this.activeTab?.closable) {
      this.closeTab(this.activeTabId);
    } else if (this.previousView) {
      this.openTab(this.previousView);
    }
  }

  setSort(column: string): void {
    const t = this.activeTab;
    if (!t) return;
    const currentCol = t.sortColumn ?? defaultSortColumn(t);
    const currentDir = t.sortDirection ?? "asc";
    if (currentCol === column) {
      t.sortDirection = currentDir === "asc" ? "desc" : "asc";
    } else {
      t.sortColumn = column;
      t.sortDirection = "asc";
    }
  }

  setFilter(value: string): void {
    const tab = this.activeTab;
    if (!tab || tab.filter === value) return;
    tab.filter = value;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTarget = tab;
    // Coalesce bursts of keystrokes, but stay short enough that results feel
    // instant: filtering a few thousand rows costs <5 ms, so the old 150 ms was
    // pure perceived latency. ~3 frames batches a fast typist without lag.
    this._debounceTimer = setTimeout(() => {
      tab._debouncedFilter = value;
      this._debounceTimer = null;
      this._debounceTarget = null;
    }, 48);
  }

  toggleStatFilter(key: string): void {
    const t = this.activeTab;
    if (!t) return;
    t.statFilter = t.statFilter === key ? null : key;
  }

  clearStatFilter(): void {
    const t = this.activeTab;
    if (!t) return;
    t.statFilter = null;
  }

  resetSelection(): void {
    const t = this.activeTab;
    if (!t) return;
    t.selectedRowIndex = -1;
  }

  /**
   * Cancel any pending debounce timer and commit its value to the target tab
   * synchronously. Keeps `filter` and `_debouncedFilter` consistent on the
   * outgoing tab when the user switches tabs mid-typing.
   */
  protected _flushDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._debounceTarget) {
      this._debounceTarget._debouncedFilter = this._debounceTarget.filter ?? "";
      this._debounceTarget = null;
    }
  }

  /** Override in subclass to add side effects (e.g., contextMenuStore.close()) */
  protected _onResetContextChange(): void {
    // no-op in logic class; overridden in UiStore
  }

  resetForContextChange(): void {
    this.commandPaletteOpen = false;
    this._flushDebounce();
    // Per-tab state is implicitly cleared by recreating the tabs array —
    // no need to touch filter/sort/statFilter/selectedRows individually.
    // mkPodsTab() is a table tab, so activeView follows to "table" on its own.
    this.tabs = [mkPodsTab()];
    this.activeTabId = DEFAULT_TAB_ID;
    this.previousView = null;
    this._onResetContextChange();
  }
}

// ── Tab persistence (serialization) ──────────────────────────────────────
// Saved to storage (survives restart):
//   id, type, label, closable, resourceName, resourceType, namespace,
//   filter, facets, sortColumn, sortDirection, statFilter
// NOT saved (ephemeral — reloaded fresh from cluster or recomputed):
//   cachedItems, cachedResource, cacheReady, count, _debouncedFilter,
//   selectedRows, selectedRowIndex
// Rationale: cached resource lists become stale in seconds. Selected rows
// and keyboard focus are session-local UX that shouldn't cross restarts.

export const TABS_STORAGE_KEY = "kdashboard-tabs-v1";
export const TABS_STORAGE_VERSION = 1;

const VALID_VIEW_TYPES = new Set<ActiveView>([
  "table", "details", "logs", "terminal", "portforwards",
  "yaml", "settings", "topology", "cost", "security", "crd-table",
  "helm", "overview", "problems",
]);

interface SerializableTab {
  id: string;
  type: ActiveView;
  label: string;
  closable: boolean;
  resourceName?: string;
  resourceType?: string;
  namespace?: string;
  filter?: string;
  facets?: Facet[];
  sortColumn?: string;
  sortDirection?: SortDirection;
  statFilter?: string | null;
}

interface SerializedTabsState {
  version: number;
  tabs: SerializableTab[];
  activeTabId: string;
}

export function serializeTabs(tabs: Tab[], activeTabId: string): SerializedTabsState {
  const serialized: SerializableTab[] = tabs.map((t) => {
    const st: SerializableTab = {
      id: t.id,
      type: t.type,
      label: t.label,
      closable: t.closable,
    };
    if (t.resourceName !== undefined) st.resourceName = t.resourceName;
    if (t.resourceType !== undefined) st.resourceType = t.resourceType;
    if (t.namespace !== undefined) st.namespace = t.namespace;
    if (t.filter !== undefined && t.filter !== "") st.filter = t.filter;
    if (t.facets !== undefined && t.facets.length > 0) st.facets = t.facets.map((f) => ({ ...f }));
    if (t.sortColumn !== undefined && t.sortColumn !== "name") st.sortColumn = t.sortColumn;
    if (t.sortDirection !== undefined && t.sortDirection !== "asc") st.sortDirection = t.sortDirection;
    if (t.statFilter !== undefined && t.statFilter !== null) st.statFilter = t.statFilter;
    return st;
  });
  return { version: TABS_STORAGE_VERSION, tabs: serialized, activeTabId };
}

/**
 * Parse and validate a persisted tabs payload. Returns `null` if the payload
 * is corrupt, from a future version, or would leave no tabs — the caller
 * should fall back to defaults in that case.
 */
export function deserializeTabs(raw: string | null): SerializedTabsState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== TABS_STORAGE_VERSION) return null;
  if (!Array.isArray(obj.tabs) || obj.tabs.length === 0) return null;
  if (typeof obj.activeTabId !== "string") return null;

  const tabs: SerializableTab[] = [];
  for (const item of obj.tabs as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.type !== "string" ||
        typeof r.label !== "string" || typeof r.closable !== "boolean") return null;
    // Unknown view types (e.g. the removed "overview") are dropped, not fatal —
    // sessions saved by older versions keep their remaining tabs.
    if (!VALID_VIEW_TYPES.has(r.type as ActiveView)) continue;
    const st: SerializableTab = {
      id: r.id, type: r.type as ActiveView, label: r.label, closable: r.closable,
    };
    if (typeof r.resourceName === "string") st.resourceName = r.resourceName;
    if (typeof r.resourceType === "string") st.resourceType = r.resourceType;
    if (typeof r.namespace === "string") st.namespace = r.namespace;
    if (typeof r.filter === "string") st.filter = r.filter;
    if (Array.isArray(r.facets)) {
      const facets = dedupeFacets(r.facets.filter(isSerializedFacet).map((f) => ({ key: f.key, op: f.op, value: f.value })));
      if (facets.length > 0) st.facets = facets;
    }
    if (typeof r.sortColumn === "string") st.sortColumn = r.sortColumn;
    if (r.sortDirection === "asc" || r.sortDirection === "desc") st.sortDirection = r.sortDirection;
    if (typeof r.statFilter === "string" || r.statFilter === null) st.statFilter = r.statFilter as string | null;
    tabs.push(st);
  }

  // Dropping unknown-type tabs may leave nothing to restore.
  if (tabs.length === 0) return null;

  // activeTabId must reference a surviving tab; if it pointed at a dropped
  // one, fall back to the first tab rather than discarding the session.
  const activeTabId = tabs.some((t) => t.id === obj.activeTabId)
    ? (obj.activeTabId as string)
    : tabs[0].id;

  return { version: TABS_STORAGE_VERSION, tabs, activeTabId };
}

const FACET_OPS = new Set([":", "!:", ">", "<", ">=", "<="]);
function isSerializedFacet(v: unknown): v is Facet {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return typeof f.key === "string" && typeof f.value === "string" &&
    typeof f.op === "string" && FACET_OPS.has(f.op);
}

/**
 * Convert a SerializableTab back to a runtime Tab. Ephemeral fields stay
 * undefined — data will be fetched fresh; selection/focus reset.
 */
export function restoreTab(st: SerializableTab): Tab {
  return {
    id: st.id,
    type: st.type,
    label: st.label,
    closable: st.closable,
    resourceName: st.resourceName,
    resourceType: st.resourceType,
    // "" is never a deliberate namespace (the picker has no all-namespaces
    // option) — it leaked from a context switch whose namespace list failed
    // to load. Restoring it would list at cluster scope (403 under
    // restrictive RBAC), so treat it as unset.
    namespace: st.namespace || undefined,
    filter: st.filter,
    _debouncedFilter: st.filter,
    facets: st.facets,
    sortColumn: st.sortColumn,
    sortDirection: st.sortDirection,
    statFilter: st.statFilter,
  };
}

/**
 * Highest numeric suffix in a set of tab ids like "tab-7". Ignores the
 * fixed "tab-pods" id. Used to bump the module-level counter so newly
 * opened tabs never collide with restored ones.
 */
export function maxTabIdSuffix(tabs: { id: string }[]): number {
  let max = 0;
  for (const t of tabs) {
    const m = /^tab-(\d+)$/.exec(t.id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}
