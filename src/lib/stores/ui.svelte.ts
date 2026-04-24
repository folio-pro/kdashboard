import { contextMenuStore } from "./context-menu.svelte.js";
import { unshadowState } from "./_unshadow.js";
import {
  UiStoreLogic,
  type ActiveView,
  type Tab,
  RESOURCE_TAB_TYPES,
  VIEW_LABELS,
  viewShowsTitleBar,
  serializeTabs,
  deserializeTabs,
  restoreTab,
  maxTabIdSuffix,
  ensureTabCounterAbove,
  TABS_STORAGE_KEY,
} from "./ui.logic.js";

export type { ActiveView, Tab };
export { RESOURCE_TAB_TYPES, VIEW_LABELS, viewShowsTitleBar };

const SAVE_DEBOUNCE_MS = 250;

class UiStore extends UiStoreLogic {
  // Store-level reactive state. Per-tab UI state (filter, sort, statFilter,
  // selectedRows, selectedRowIndex, _debouncedFilter) lives on `Tab` and is
  // accessed via inherited getters on `UiStoreLogic` — the deep $state proxy
  // on `tabs` makes nested tab fields reactive automatically.
  override sidebarCollapsed = $state<boolean>(false);
  override commandPaletteOpen = $state<boolean>(false);
  override activeView = $state<ActiveView>("overview");
  override previousView = $state<ActiveView | null>(null);

  // Tab system
  override tabs = $state<Tab[]>([{ id: "tab-overview", type: "overview", label: "Overview", closable: true }]);
  override activeTabId = $state<string>("tab-overview");

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    unshadowState(this);
    // Hydrate AFTER unshadow so writes go through the reactive setters.
    this._hydrateFromStorage();
    this._installAutosave();
  }

  /**
   * Restore tabs and active-tab selection from localStorage. Silent on any
   * failure — corrupt/missing data falls back to the default overview tab
   * already seeded by the $state declaration.
   */
  private _hydrateFromStorage(): void {
    if (typeof localStorage === "undefined") return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(TABS_STORAGE_KEY);
    } catch {
      return;
    }
    const state = deserializeTabs(raw);
    if (!state) return;
    this.tabs = state.tabs.map(restoreTab);
    this.activeTabId = state.activeTabId;
    const activeTab = this.tabs.find((t) => t.id === state.activeTabId);
    if (activeTab) this.activeView = activeTab.type;
    // Prevent id collisions with newly opened tabs.
    ensureTabCounterAbove(maxTabIdSuffix(this.tabs));
  }

  /**
   * Watch tabs + activeTabId and persist on change, debounced so a burst of
   * mutations (typing in the filter input) doesn't thrash localStorage.
   * $effect.root gives the effect a scope tied to the store's lifetime.
   */
  private _installAutosave(): void {
    if (typeof localStorage === "undefined") return;
    $effect.root(() => {
      $effect(() => {
        // Touch reactive deps; defer the actual serialize + write until the
        // debounce fires so a burst of keystrokes doesn't rebuild snapshots
        // we'd only discard.
        void this.activeTabId;
        for (const t of this.tabs) {
          void t.filter; void t.sortColumn; void t.sortDirection;
          void t.statFilter; void t.label; void t.resourceName;
          void t.resourceType; void t.namespace;
        }
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
          try {
            const snapshot = serializeTabs(this.tabs, this.activeTabId);
            localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(snapshot));
          } catch {
            // Quota exceeded or storage disabled — session restore is best-effort.
          }
          this._saveTimer = null;
        }, SAVE_DEBOUNCE_MS);
      });
    });
  }

  protected override _onResetContextChange(): void {
    contextMenuStore.close();
  }
}

export type { UiStore };
export const uiStore = new UiStore();
