import type { SortDirection, Resource } from "../types/index.js";

export type ActiveView = "overview" | "table" | "details" | "logs" | "terminal" | "portforwards" | "yaml" | "settings" | "topology" | "cost" | "security" | "crd-table";

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
  cachedItems?: Resource[];
  /** True once a load has completed for this tab; distinguishes a legitimately
   *  empty result from an in-flight/uninitialized load. */
  cacheReady?: boolean;
  /** Cached selected resource — restores detail/logs/yaml/terminal views on tab switch */
  cachedResource?: Resource;

  // Per-tab UI state. All optional — absent means "default" via getter fallback.
  /** Search filter text. */
  filter?: string;
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
}

const EMPTY_SELECTED_ROWS: Set<string> = new Set();

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
const SINGLETON_VIEWS = new Set<ActiveView>(["overview", "settings", "topology", "cost", "security", "portforwards"]);

/** View types tied to a specific resource (cache selectedResource on tab switch) */
export const RESOURCE_TAB_TYPES = new Set<ActiveView>(["details", "logs", "yaml", "terminal"]);

/**
 * View types that render their own header and should suppress the global
 * `<TitleBar />`. Kept as the allowlist's *complement* because new views
 * default to having a title bar (fail safe — surface > hide).
 */
const VIEWS_WITHOUT_TITLE_BAR = new Set<ActiveView>([
  "overview",
  "details",
  "logs",
  "terminal",
  "yaml",
  "settings",
]);

export function viewShowsTitleBar(view: ActiveView): boolean {
  return !VIEWS_WITHOUT_TITLE_BAR.has(view);
}

/** Canonical display labels for each view type */
export const VIEW_LABELS: Record<ActiveView, string> = {
  overview: "Overview", table: "Resources", details: "Detail",
  logs: "Logs", terminal: "Terminal", portforwards: "Port Forwards",
  yaml: "YAML", settings: "Settings",
  topology: "Topology", cost: "Cost", security: "Security",
  "crd-table": "CRDs",
};

function mkOverviewTab(): Tab {
  return { id: "tab-overview", type: "overview", label: "Overview", closable: true };
}

export class UiStoreLogic {
  sidebarCollapsed = false;
  commandPaletteOpen = false;
  activeView: ActiveView = "overview";
  previousView: ActiveView | null = null;

  // Tab system
  tabs: Tab[] = [mkOverviewTab()];
  activeTabId = "tab-overview";

  // Debounce timer lives on the store (single shared handle), but each
  // setFilter call captures its target tab in the closure so a fast
  // tab-switch doesn't misroute the deferred write.
  protected _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected _debounceTarget: Tab | null = null;

  get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
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

  get filterLower(): string {
    return this.filter.toLowerCase();
  }

  get debouncedFilterLower(): string {
    return (this.activeTab?._debouncedFilter ?? "").toLowerCase();
  }

  get sortColumn(): string {
    return this.activeTab?.sortColumn ?? "name";
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

  get selectedRowIndex(): number {
    return this.activeTab?.selectedRowIndex ?? -1;
  }
  set selectedRowIndex(v: number) {
    const t = this.activeTab;
    if (t) t.selectedRowIndex = v;
  }

  openTab(type: ActiveView, opts?: { label?: string; resourceName?: string; resourceType?: string; namespace?: string }): void {
    // Singleton views: focus existing tab if open
    if (SINGLETON_VIEWS.has(type)) {
      const existing = this.tabs.find((t) => t.type === type);
      if (existing) {
        this.activateTab(existing.id);
        return;
      }
    }

    // Resource tabs: focus existing tab for same resource
    if (opts?.resourceName && opts?.resourceType) {
      const existing = this.tabs.find(
        (t) => t.type === type && t.resourceName === opts.resourceName && t.resourceType === opts.resourceType
      );
      if (existing) {
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
    this.activeView = tab.type;
    // No reset of filter/sort/statFilter/selectedRows — each tab owns its state.
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.closable) return;
    const idx = this.tabs.indexOf(tab);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    // If no tabs left, reopen overview
    if (this.tabs.length === 0) {
      this.tabs = [mkOverviewTab()];
      this.activateTab("tab-overview");
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
    this.tabs = [mkOverviewTab()];
    this.activateTab("tab-overview");
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

  protected _switchView(view: ActiveView, opts?: { label?: string; resourceName?: string; resourceType?: string }): void {
    this.previousView = this.activeView;
    this.openTab(view, opts);
  }

  showOverview(): void {
    this._switchView("overview");
  }

  showSettings(): void {
    this._switchView("settings");
  }

  showDetails(resourceName?: string, resourceType?: string): void {
    this._switchView("details", {
      label: resourceName ?? "Detail",
      resourceName,
      resourceType,
    });
  }

  showLogs(resourceName?: string): void {
    this._switchView("logs", { label: resourceName ?? "Logs", resourceName });
  }

  showTerminal(resourceName?: string): void {
    this._switchView("terminal", { label: resourceName ?? "Terminal", resourceName });
  }

  showYamlEditor(resourceName?: string): void {
    this._switchView("yaml", { label: resourceName ?? "YAML", resourceName });
  }

  showPortForwards(): void {
    this._switchView("portforwards");
  }

  showTopology(): void {
    this._switchView("topology");
  }

  showCost(): void {
    this._switchView("cost");
  }

  showSecurity(): void {
    this._switchView("security");
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
    const currentCol = t.sortColumn ?? "name";
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
    this._debounceTimer = setTimeout(() => {
      tab._debouncedFilter = value;
      this._debounceTimer = null;
      this._debounceTarget = null;
    }, 150);
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
    this.tabs = [mkOverviewTab()];
    this.activeTabId = "tab-overview";
    this.activeView = "overview";
    this.previousView = null;
    this._onResetContextChange();
  }
}

// ── Tab persistence (serialization) ──────────────────────────────────────
// Saved to storage (survives restart):
//   id, type, label, closable, resourceName, resourceType, namespace,
//   filter, sortColumn, sortDirection, statFilter
// NOT saved (ephemeral — reloaded fresh from cluster or recomputed):
//   cachedItems, cachedResource, cacheReady, count, _debouncedFilter,
//   selectedRows, selectedRowIndex
// Rationale: cached resource lists become stale in seconds. Selected rows
// and keyboard focus are session-local UX that shouldn't cross restarts.

export const TABS_STORAGE_KEY = "kdashboard-tabs-v1";
export const TABS_STORAGE_VERSION = 1;

const VALID_VIEW_TYPES = new Set<ActiveView>([
  "overview", "table", "details", "logs", "terminal", "portforwards",
  "yaml", "settings", "topology", "cost", "security", "crd-table",
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
    if (!VALID_VIEW_TYPES.has(r.type as ActiveView)) return null;
    const st: SerializableTab = {
      id: r.id, type: r.type as ActiveView, label: r.label, closable: r.closable,
    };
    if (typeof r.resourceName === "string") st.resourceName = r.resourceName;
    if (typeof r.resourceType === "string") st.resourceType = r.resourceType;
    if (typeof r.namespace === "string") st.namespace = r.namespace;
    if (typeof r.filter === "string") st.filter = r.filter;
    if (typeof r.sortColumn === "string") st.sortColumn = r.sortColumn;
    if (r.sortDirection === "asc" || r.sortDirection === "desc") st.sortDirection = r.sortDirection;
    if (typeof r.statFilter === "string" || r.statFilter === null) st.statFilter = r.statFilter as string | null;
    tabs.push(st);
  }

  // activeTabId must reference an existing tab
  if (!tabs.some((t) => t.id === obj.activeTabId)) return null;

  return { version: TABS_STORAGE_VERSION, tabs, activeTabId: obj.activeTabId };
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
    namespace: st.namespace,
    filter: st.filter,
    sortColumn: st.sortColumn,
    sortDirection: st.sortDirection,
    statFilter: st.statFilter,
  };
}

/**
 * Highest numeric suffix in a set of tab ids like "tab-7". Ignores the
 * fixed "tab-overview" id. Used to bump the module-level counter so newly
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
