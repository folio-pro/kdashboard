import { contextMenuStore } from "./context-menu.svelte.js";
import { unshadowState } from "./_unshadow.js";
import {
  UiStoreLogic,
  type ActiveView,
  type Tab,
  RESOURCE_TAB_TYPES,
  VIEW_LABELS,
  viewShowsTitleBar,
} from "./ui.logic.js";

export type { ActiveView, Tab };
export { RESOURCE_TAB_TYPES, VIEW_LABELS, viewShowsTitleBar };

class UiStore extends UiStoreLogic {
  override sidebarCollapsed = $state<boolean>(false);
  override commandPaletteOpen = $state<boolean>(false);
  override filter = $state<string>("");
  // @ts-expect-error -- $derived compiles to accessor; TS cannot see that
  override filterLower = $derived(this.filter.toLowerCase());
  override _debouncedFilter = $state<string>("");
  // @ts-expect-error -- $derived compiles to accessor; TS cannot see that
  override debouncedFilterLower = $derived(this._debouncedFilter.toLowerCase());
  override sortColumn = $state<string>("name");
  override sortDirection = $state<import("../types/index.js").SortDirection>("asc");
  override activeView = $state<ActiveView>("overview");
  override previousView = $state<ActiveView | null>(null);
  override selectedRowIndex = $state<number>(-1);
  override selectedRows = $state<Set<string>>(new Set());
  override statFilter = $state<string | null>(null);

  // Tab system
  override tabs = $state<Tab[]>([{ id: "tab-overview", type: "overview", label: "Overview", closable: true }]);
  override activeTabId = $state<string>("tab-overview");


  constructor() {
    super();
    unshadowState(this);
  }

  protected override _onResetContextChange(): void {
    contextMenuStore.close();
  }
}

export type { UiStore };
export const uiStore = new UiStore();
