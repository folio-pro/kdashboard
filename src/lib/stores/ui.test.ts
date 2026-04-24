import { describe, expect, test, beforeEach } from "bun:test";
import {
  UiStoreLogic,
  resetTabCounter,
  viewShowsTitleBar,
  serializeTabs,
  deserializeTabs,
  restoreTab,
  maxTabIdSuffix,
  TABS_STORAGE_VERSION,
  type ActiveView,
  type Tab,
} from "./ui.logic.js";

describe("UiStore", () => {
  let store: UiStoreLogic;

  beforeEach(() => {
    resetTabCounter();
    store = new UiStoreLogic();
  });

  describe("row selection", () => {
    test("toggleRowSelection adds a UID", () => {
      store.toggleRowSelection("uid-1");
      expect(store.selectedRows.has("uid-1")).toBe(true);
      expect(store.selectedCount).toBe(1);
    });

    test("toggleRowSelection removes an existing UID", () => {
      store.toggleRowSelection("uid-1");
      store.toggleRowSelection("uid-1");
      expect(store.selectedRows.has("uid-1")).toBe(false);
      expect(store.selectedCount).toBe(0);
    });

    test("toggleRowSelection handles multiple UIDs", () => {
      store.toggleRowSelection("uid-1");
      store.toggleRowSelection("uid-2");
      store.toggleRowSelection("uid-3");
      expect(store.selectedCount).toBe(3);
      store.toggleRowSelection("uid-2");
      expect(store.selectedCount).toBe(2);
      expect(store.selectedRows.has("uid-2")).toBe(false);
    });

    test("selectAllRows sets all UIDs", () => {
      store.selectAllRows(["a", "b", "c"]);
      expect(store.selectedCount).toBe(3);
      expect(store.selectedRows.has("a")).toBe(true);
      expect(store.selectedRows.has("b")).toBe(true);
      expect(store.selectedRows.has("c")).toBe(true);
    });

    test("selectAllRows replaces previous selection", () => {
      store.toggleRowSelection("old");
      store.selectAllRows(["new-1", "new-2"]);
      expect(store.selectedRows.has("old")).toBe(false);
      expect(store.selectedCount).toBe(2);
    });

    test("clearSelection empties the set", () => {
      store.selectAllRows(["a", "b", "c"]);
      store.clearSelection();
      expect(store.selectedCount).toBe(0);
    });

    test("selectedCount returns correct count", () => {
      expect(store.selectedCount).toBe(0);
      store.toggleRowSelection("x");
      expect(store.selectedCount).toBe(1);
      store.selectAllRows(["a", "b", "c", "d"]);
      expect(store.selectedCount).toBe(4);
    });
  });

  describe("sidebar and panels", () => {
    test("toggleSidebar flips sidebarCollapsed", () => {
      expect(store.sidebarCollapsed).toBe(false);
      store.toggleSidebar();
      expect(store.sidebarCollapsed).toBe(true);
      store.toggleSidebar();
      expect(store.sidebarCollapsed).toBe(false);
    });

    test("toggleCommandPalette flips commandPaletteOpen", () => {
      expect(store.commandPaletteOpen).toBe(false);
      store.toggleCommandPalette();
      expect(store.commandPaletteOpen).toBe(true);
      store.toggleCommandPalette();
      expect(store.commandPaletteOpen).toBe(false);
    });
  });

  describe("view switching", () => {
    test("showDetails switches to details and saves previousView", () => {
      store.showDetails();
      expect(store.activeView).toBe("details");
      expect(store.previousView).toBe("overview");
    });

    test("showLogs switches to logs", () => {
      store.showLogs();
      expect(store.activeView).toBe("logs");
      expect(store.previousView).toBe("overview");
    });

    test("showTerminal switches to terminal", () => {
      store.showTerminal();
      expect(store.activeView).toBe("terminal");
      expect(store.previousView).toBe("overview");
    });

    test("showYamlEditor switches to yaml", () => {
      store.showYamlEditor();
      expect(store.activeView).toBe("yaml");
      expect(store.previousView).toBe("overview");
    });

    test("showSettings switches to settings", () => {
      store.showSettings();
      expect(store.activeView).toBe("settings");
      expect(store.previousView).toBe("overview");
    });

    test("showPortForwards switches to portforwards", () => {
      store.showPortForwards();
      expect(store.activeView).toBe("portforwards");
      expect(store.previousView).toBe("overview");
    });

    test("new tab starts with empty filter (per-tab state)", () => {
      store.setFilter("some-filter");
      expect(store.filter).toBe("some-filter");
      // Opening a new tab switches activeTab; the new tab has its own empty filter
      store.showDetails();
      expect(store.filter).toBe("");
    });

    test("backToPrevious closes current tab and activates nearest", () => {
      store.showDetails();
      store.showLogs();
      expect(store.activeView).toBe("logs");
      expect(store.previousView).toBe("details");
      store.backToPrevious();
      // closing logs tab activates the nearest remaining tab
      expect(store.activeView).not.toBe("logs");
    });

    test("backToPrevious from overview reopens overview (only tab)", () => {
      // overview is the only tab, closing it re-creates overview
      store.backToPrevious();
      expect(store.activeView).toBe("overview");
    });

    test("backToPrevious goes to nearest tab (filter is per-tab)", () => {
      store.showDetails();
      store.setFilter("test");
      expect(store.filter).toBe("test");
      store.backToPrevious();
      // details tab closed; activeTab is now the overview tab, which never had a filter set
      expect(store.filter).toBe("");
    });

    test("backToTable opens a table tab", () => {
      store.showDetails();
      store.showLogs();
      store.backToTable();
      expect(store.activeView).toBe("table");
    });

    test("backToTable reuses existing table tab", () => {
      store.backToTable("Resources", "pods");
      const tabCount = store.tabs.length;
      store.showLogs();
      store.backToTable(undefined, "pods");
      // should not have added a new tab
      expect(store.tabs.length).toBe(tabCount + 1); // +1 for the logs tab
      expect(store.activeView).toBe("table");
    });

    test("toggleSettings from overview goes to settings", () => {
      store.toggleSettings();
      expect(store.activeView).toBe("settings");
      expect(store.previousView).toBe("overview");
    });

    test("toggleSettings from settings goes back", () => {
      store.showDetails();
      store.toggleSettings();
      expect(store.activeView).toBe("settings");
      store.toggleSettings();
      // closing settings tab goes to nearest remaining tab
      expect(store.activeView).not.toBe("settings");
    });

  });

  describe("sorting", () => {
    test("setSort on same column toggles direction", () => {
      expect(store.sortColumn).toBe("name");
      expect(store.sortDirection).toBe("asc");
      store.setSort("name");
      expect(store.sortDirection).toBe("desc");
      store.setSort("name");
      expect(store.sortDirection).toBe("asc");
    });

    test("setSort on new column sets asc", () => {
      store.setSort("name"); // desc
      store.setSort("age");
      expect(store.sortColumn).toBe("age");
      expect(store.sortDirection).toBe("asc");
    });
  });

  describe("filter", () => {
    test("setFilter updates filter value", () => {
      store.setFilter("pods");
      expect(store.filter).toBe("pods");
    });

    test("filterLower returns lowercase", () => {
      store.setFilter("MyDeployment");
      expect(store.filterLower).toBe("mydeployment");
    });
  });

  describe("tab system", () => {
    test("starts with overview tab active", () => {
      expect(store.tabs.length).toBe(1);
      expect(store.activeTab?.type).toBe("overview");
    });

    test("openTab adds a new tab and activates it", () => {
      store.openTab("table", { label: "Pods" });
      expect(store.tabs.length).toBe(2);
      expect(store.activeView).toBe("table");
    });

    test("singleton views reuse existing tab", () => {
      store.openTab("settings");
      const tabCount = store.tabs.length;
      store.openTab("overview"); // go back to overview
      store.openTab("settings"); // should reuse, not add
      expect(store.tabs.length).toBe(tabCount);
      expect(store.activeView).toBe("settings");
    });

    test("closeTab removes tab and activates nearest", () => {
      store.openTab("table", { label: "Pods" });
      store.openTab("table", { label: "Services" });
      const tabId = store.activeTabId;
      store.closeTab(tabId);
      expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
    });

    test("closeAllTabs resets to overview", () => {
      store.openTab("table", { label: "Pods" });
      store.openTab("settings");
      store.closeAllTabs();
      expect(store.tabs.length).toBe(1);
      expect(store.activeView).toBe("overview");
    });

    test("moveTab swaps tab positions", () => {
      store.openTab("table", { label: "Pods" });
      const firstId = store.tabs[0].id;
      const secondId = store.tabs[1].id;
      store.moveTab(secondId, "left");
      expect(store.tabs[0].id).toBe(secondId);
      expect(store.tabs[1].id).toBe(firstId);
    });

    test("closeOtherTabs keeps only specified tab", () => {
      store.openTab("table", { label: "Pods" });
      store.openTab("settings");
      const tableTabId = store.tabs.find((t) => t.type === "table")!.id;
      store.closeOtherTabs(tableTabId);
      expect(store.tabs.length).toBe(1);
      expect(store.tabs[0].id).toBe(tableTabId);
    });
  });

  describe("stat filter", () => {
    test("toggleStatFilter sets and clears", () => {
      store.toggleStatFilter("running");
      expect(store.statFilter).toBe("running");
      store.toggleStatFilter("running");
      expect(store.statFilter).toBeNull();
    });

    test("toggleStatFilter switches to different key", () => {
      store.toggleStatFilter("running");
      store.toggleStatFilter("pending");
      expect(store.statFilter).toBe("pending");
    });

    test("clearStatFilter clears", () => {
      store.toggleStatFilter("running");
      store.clearStatFilter();
      expect(store.statFilter).toBeNull();
    });
  });

  describe("reset", () => {
    test("resetSelection sets selectedRowIndex to -1", () => {
      store.selectedRowIndex = 5;
      store.resetSelection();
      expect(store.selectedRowIndex).toBe(-1);
    });

    test("resetForContextChange resets everything to defaults", () => {
      // Mutate everything
      store.commandPaletteOpen = true;
      store.filter = "test";
      store.sortColumn = "status";
      store.sortDirection = "desc";
      store.showLogs();
      store.previousView = "details";
      store.selectedRowIndex = 3;
      store.selectAllRows(["a", "b"]);
      store.statFilter = "running";

      store.resetForContextChange();

      expect(store.commandPaletteOpen).toBe(false);
      // Per-tab state is implicitly reset: resetForContextChange() recreates
      // the tabs array with a fresh overview tab, so all per-tab fields
      // fall back to their getter defaults.
      expect(store.filter).toBe("");
      expect(store.sortColumn).toBe("name");
      expect(store.sortDirection as "asc" | "desc").toBe("asc");
      expect(store.activeView).toBe("overview");
      expect(store.previousView).toBeNull();
      expect(store.selectedRowIndex).toBe(-1);
      expect(store.selectedCount).toBe(0);
      expect(store.statFilter).toBeNull();
    });
  });

  describe("per-tab state", () => {
    test("filter persists across tab switches", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.setFilter("nginx");
      expect(store.filter).toBe("nginx");

      store.openTab("table", { label: "Services", resourceType: "services" });
      const servicesId = store.activeTabId;
      expect(store.filter).toBe("");

      store.setFilter("api");
      expect(store.filter).toBe("api");

      store.activateTab(podsId);
      expect(store.filter).toBe("nginx");

      store.activateTab(servicesId);
      expect(store.filter).toBe("api");
    });

    test("sortColumn and sortDirection persist per-tab", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.setSort("cpu");
      expect(store.sortColumn).toBe("cpu");
      expect(store.sortDirection).toBe("asc");

      store.openTab("table", { label: "Services", resourceType: "services" });
      // new tab: defaults
      expect(store.sortColumn).toBe("name");
      expect(store.sortDirection).toBe("asc");

      store.activateTab(podsId);
      expect(store.sortColumn).toBe("cpu");
    });

    test("statFilter persists per-tab", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.toggleStatFilter("running");
      expect(store.statFilter).toBe("running");

      store.openTab("table", { label: "Services", resourceType: "services" });
      expect(store.statFilter).toBeNull();

      store.activateTab(podsId);
      expect(store.statFilter).toBe("running");
    });

    test("selectedRows do not leak across tabs", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.selectAllRows(["pod-uid-1", "pod-uid-2"]);
      expect(store.selectedCount).toBe(2);

      store.openTab("table", { label: "Services", resourceType: "services" });
      expect(store.selectedCount).toBe(0);
      expect(store.selectedRows.has("pod-uid-1")).toBe(false);

      store.toggleRowSelection("svc-uid-1");
      expect(store.selectedCount).toBe(1);

      store.activateTab(podsId);
      expect(store.selectedCount).toBe(2);
      expect(store.selectedRows.has("pod-uid-1")).toBe(true);
      expect(store.selectedRows.has("svc-uid-1")).toBe(false);
    });

    test("selectedRowIndex is per-tab", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.selectedRowIndex = 5;
      expect(store.selectedRowIndex).toBe(5);

      store.openTab("table", { label: "Services", resourceType: "services" });
      expect(store.selectedRowIndex).toBe(-1);

      store.activateTab(podsId);
      expect(store.selectedRowIndex).toBe(5);
    });

    test("filter round-trips through detail view", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.setFilter("nginx");

      // open detail (new tab, inherits nothing)
      store.showDetails("nginx-abc123", "pods");
      expect(store.filter).toBe("");

      // back to pods — filter must still be there
      store.activateTab(podsId);
      expect(store.filter).toBe("nginx");
    });

    test("closing a tab discards its filter (no leak to remaining tabs)", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      store.setFilter("nginx");
      const podsId = store.activeTabId;

      store.closeTab(podsId);
      // now on overview, which has no filter
      expect(store.filter).toBe("");
    });

    test("debounced filter writes to the correct tab after switch", async () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.setFilter("nginx");
      expect(store.filter).toBe("nginx");
      // debounced not yet fired
      expect(store.debouncedFilterLower).toBe("");

      // Switch before debounce fires — _flushDebounce commits the value
      // to the outgoing (pods) tab synchronously.
      store.openTab("table", { label: "Services", resourceType: "services" });
      expect(store.debouncedFilterLower).toBe(""); // services tab, no filter

      store.activateTab(podsId);
      expect(store.filter).toBe("nginx");
      expect(store.debouncedFilterLower).toBe("nginx");
    });

    test("setFilter debounce fires on the captured tab even after switch", async () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      const podsId = store.activeTabId;
      store.setFilter("nginx");

      // Switch tabs. _flushDebounce commits "nginx" to pods tab synchronously.
      store.openTab("table", { label: "Services", resourceType: "services" });
      store.setFilter("api");

      // Wait beyond debounce
      await new Promise((r) => setTimeout(r, 200));

      // Services debounced should now be "api"
      expect(store.debouncedFilterLower).toBe("api");

      // Pods debounced should be "nginx" (flushed at switch, not overwritten)
      store.activateTab(podsId);
      expect(store.debouncedFilterLower).toBe("nginx");
    });

    test("tab without per-tab fields falls back to defaults (backwards compat)", () => {
      // Simulate a tab constructed without optional fields (e.g., by legacy
      // code or future deserialization).
      const legacyTab: Tab = {
        id: "tab-legacy",
        type: "table",
        label: "Legacy",
        closable: true,
      };
      store.tabs = [...store.tabs, legacyTab];
      store.activateTab("tab-legacy");

      expect(store.filter).toBe("");
      expect(store.sortColumn).toBe("name");
      expect(store.sortDirection).toBe("asc");
      expect(store.statFilter).toBeNull();
      expect(store.selectedCount).toBe(0);
      expect(store.selectedRowIndex).toBe(-1);
    });
  });

  describe("tab persistence (serialization)", () => {
    test("serializeTabs strips ephemeral fields", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods" });
      store.setFilter("nginx");
      store.setSort("cpu");
      store.selectAllRows(["uid-1", "uid-2"]);
      store.selectedRowIndex = 3;
      // Simulate cache population
      const tab = store.activeTab!;
      tab.cachedItems = [];
      tab.cacheReady = true;
      tab.count = 42;

      const snap = serializeTabs(store.tabs, store.activeTabId);
      const persistedPods = snap.tabs.find((t) => t.label === "Pods")!;

      // Saved:
      expect(persistedPods.filter).toBe("nginx");
      expect(persistedPods.sortColumn).toBe("cpu");
      expect(persistedPods.resourceType).toBe("pods");

      // NOT saved (not present on SerializableTab at all):
      expect("cachedItems" in persistedPods).toBe(false);
      expect("cachedResource" in persistedPods).toBe(false);
      expect("cacheReady" in persistedPods).toBe(false);
      expect("count" in persistedPods).toBe(false);
      expect("selectedRows" in persistedPods).toBe(false);
      expect("selectedRowIndex" in persistedPods).toBe(false);
      expect("_debouncedFilter" in persistedPods).toBe(false);
    });

    test("serializeTabs omits defaults to keep payload small", () => {
      // overview tab with no filter/sort/statFilter set
      const snap = serializeTabs(store.tabs, store.activeTabId);
      const overview = snap.tabs[0];
      expect("filter" in overview).toBe(false);
      expect("sortColumn" in overview).toBe(false);
      expect("sortDirection" in overview).toBe(false);
      expect("statFilter" in overview).toBe(false);
    });

    test("serialize + deserialize round-trip", () => {
      store.openTab("table", { label: "Pods", resourceType: "pods", namespace: "default" });
      store.setFilter("nginx");
      store.setSort("cpu");
      store.setSort("cpu"); // toggle to desc
      store.toggleStatFilter("running");

      const snap = serializeTabs(store.tabs, store.activeTabId);
      const json = JSON.stringify(snap);
      const parsed = deserializeTabs(json);
      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(TABS_STORAGE_VERSION);
      expect(parsed!.activeTabId).toBe(store.activeTabId);
      expect(parsed!.tabs.length).toBe(store.tabs.length);

      const restored = parsed!.tabs.map(restoreTab);
      const podsRestored = restored.find((t) => t.label === "Pods")!;
      expect(podsRestored.filter).toBe("nginx");
      expect(podsRestored.sortColumn).toBe("cpu");
      expect(podsRestored.sortDirection).toBe("desc");
      expect(podsRestored.statFilter).toBe("running");
      expect(podsRestored.resourceType).toBe("pods");
      expect(podsRestored.namespace).toBe("default");
    });

    test("deserializeTabs rejects null / empty / invalid JSON", () => {
      expect(deserializeTabs(null)).toBeNull();
      expect(deserializeTabs("")).toBeNull();
      expect(deserializeTabs("{not json")).toBeNull();
      expect(deserializeTabs("[]")).toBeNull();
    });

    test("deserializeTabs rejects wrong version", () => {
      const bad = JSON.stringify({
        version: 999,
        tabs: [{ id: "tab-overview", type: "overview", label: "Overview", closable: true }],
        activeTabId: "tab-overview",
      });
      expect(deserializeTabs(bad)).toBeNull();
    });

    test("deserializeTabs rejects unknown tab type", () => {
      const bad = JSON.stringify({
        version: TABS_STORAGE_VERSION,
        tabs: [{ id: "tab-1", type: "does-not-exist", label: "?", closable: true }],
        activeTabId: "tab-1",
      });
      expect(deserializeTabs(bad)).toBeNull();
    });

    test("deserializeTabs rejects payload with dangling activeTabId", () => {
      const bad = JSON.stringify({
        version: TABS_STORAGE_VERSION,
        tabs: [{ id: "tab-overview", type: "overview", label: "Overview", closable: true }],
        activeTabId: "tab-missing",
      });
      expect(deserializeTabs(bad)).toBeNull();
    });

    test("deserializeTabs rejects empty tabs array", () => {
      const bad = JSON.stringify({
        version: TABS_STORAGE_VERSION,
        tabs: [],
        activeTabId: "tab-overview",
      });
      expect(deserializeTabs(bad)).toBeNull();
    });

    test("maxTabIdSuffix finds highest numeric suffix", () => {
      expect(maxTabIdSuffix([])).toBe(0);
      expect(maxTabIdSuffix([{ id: "tab-overview" }])).toBe(0);
      expect(maxTabIdSuffix([
        { id: "tab-overview" },
        { id: "tab-1" },
        { id: "tab-7" },
        { id: "tab-3" },
      ])).toBe(7);
      // mixed / malformed ids — ignored
      expect(maxTabIdSuffix([{ id: "weird-5" }, { id: "tab-2" }])).toBe(2);
    });

    test("restoreTab discards ephemeral fields by construction", () => {
      // The SerializableTab type has no cache/selection fields, so restoreTab
      // produces a runtime Tab with those undefined — verified by shape check.
      const restored = restoreTab({
        id: "tab-1", type: "table", label: "Pods", closable: true,
        resourceType: "pods", filter: "nginx",
      });
      expect(restored.filter).toBe("nginx");
      expect(restored.cachedItems).toBeUndefined();
      expect(restored.selectedRows).toBeUndefined();
      expect(restored.selectedRowIndex).toBeUndefined();
    });
  });

  describe("viewShowsTitleBar", () => {
    test("hides TitleBar for views that render their own header", () => {
      const hidden: ActiveView[] = [
        "overview",
        "details",
        "logs",
        "terminal",
        "yaml",
        "settings",
      ];
      for (const v of hidden) {
        expect(viewShowsTitleBar(v)).toBe(false);
      }
    });

    test("shows TitleBar for resource/list/dashboard views", () => {
      const shown: ActiveView[] = [
        "table",
        "crd-table",
        "portforwards",
        "topology",
        "cost",
        "security",
      ];
      for (const v of shown) {
        expect(viewShowsTitleBar(v)).toBe(true);
      }
    });
  });
});
