import { describe, expect, test, beforeEach } from "bun:test";
import { UiStoreLogic, resetTabCounter } from "./ui.logic.js";

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

    test("_switchView clears filter on tab activation", () => {
      store.setFilter("some-filter");
      expect(store.filter).toBe("some-filter");
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

    test("backToPrevious clears filter", () => {
      store.showDetails();
      store.setFilter("test");
      store.backToPrevious();
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
      expect(store.filter).toBe("");
      expect(store.sortColumn).toBe("name");
      expect(store.sortDirection).toBe("asc");
      expect(store.activeView).toBe("overview");
      expect(store.previousView).toBeNull();
      expect(store.selectedRowIndex).toBe(-1);
      expect(store.selectedCount).toBe(0);
      expect(store.statFilter).toBeNull();
    });
  });
});
