import type { SortDirection, Resource } from "../types/index.js";

export type ActiveView = "overview" | "table" | "details" | "logs" | "terminal" | "portforwards" | "yaml" | "settings" | "topology" | "cost" | "security" | "crd-table";

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
}

let _tabCounter = 0;
function nextTabId(): string {
  return `tab-${++_tabCounter}`;
}

/** Reset the tab counter (useful in tests) */
export function resetTabCounter(): void {
  _tabCounter = 0;
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
  filter = "";
  protected _debouncedFilter = "";
  protected _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  sortColumn = "name";
  sortDirection: SortDirection = "asc";
  activeView: ActiveView = "overview";
  previousView: ActiveView | null = null;
  selectedRowIndex = -1;
  selectedRows = new Set<string>();
  statFilter: string | null = null;

  // Tab system
  tabs: Tab[] = [mkOverviewTab()];
  activeTabId = "tab-overview";

  get filterLower(): string {
    return this.filter.toLowerCase();
  }

  get debouncedFilterLower(): string {
    return this._debouncedFilter.toLowerCase();
  }

  get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
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
      this.onBeforeTabSwitch?.(from, tab);
    }
    this.activeTabId = tabId;
    this.activeView = tab.type;
    this.filter = "";
    this._clearDebounce();
    this.statFilter = null;
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
    const next = new Set(this.selectedRows);
    if (next.has(uid)) {
      next.delete(uid);
    } else {
      next.add(uid);
    }
    this.selectedRows = next;
  }

  selectAllRows(uids: string[]): void {
    this.selectedRows = new Set(uids);
  }

  clearSelection(): void {
    this.selectedRows = new Set();
  }

  get selectedCount(): number {
    return this.selectedRows.size;
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
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortColumn = column;
      this.sortDirection = "asc";
    }
  }

  setFilter(value: string): void {
    this.filter = value;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debouncedFilter = value;
    }, 150);
  }

  toggleStatFilter(key: string): void {
    this.statFilter = this.statFilter === key ? null : key;
  }

  clearStatFilter(): void {
    this.statFilter = null;
  }

  resetSelection(): void {
    this.selectedRowIndex = -1;
  }

  protected _clearDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._debouncedFilter = this.filter;
  }

  /** Override in subclass to add side effects (e.g., contextMenuStore.close()) */
  protected _onResetContextChange(): void {
    // no-op in logic class; overridden in UiStore
  }

  resetForContextChange(): void {
    this.commandPaletteOpen = false;
    this.filter = "";
    this._clearDebounce();
    this.sortColumn = "name";
    this.sortDirection = "asc";
    this.tabs = [mkOverviewTab()];
    this.activeTabId = "tab-overview";
    this.activeView = "overview";
    this.previousView = null;
    this.selectedRowIndex = -1;
    this.selectedRows = new Set();
    this.statFilter = null;
    this._onResetContextChange();
  }
}
