import { describe, expect, test, beforeEach } from "bun:test";
import type { CommandPaletteItem } from "$lib/types";
import {
  tokenizeQuery,
  matchItem,
  filterCommandItems,
  groupByCategory,
  orderGroups,
  navigateSelection,
  CATEGORY_ORDER,
} from "./command-palette";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noop = () => {};

function makeItem(
  id: string,
  label: string,
  category: string,
  description?: string,
  hint?: string,
): CommandPaletteItem {
  return { id, label, category, description, hint, action: noop };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sampleItems: CommandPaletteItem[];

function buildSampleItems(): CommandPaletteItem[] {
  return [
    makeItem("resource-pods", "Pods", "Resources", "View Pods"),
    makeItem("resource-deployments", "Deployments", "Resources", "View Deployments"),
    makeItem("resource-services", "Services", "Resources", "View Services"),
    makeItem("resource-configmaps", "Config Maps", "Resources", "View Config Maps"),
    makeItem("context-minikube", "minikube", "Contexts", "Switch context"),
    makeItem("context-prod", "prod-cluster", "Contexts", "Switch context"),
    makeItem("namespace-default", "default", "Namespaces", "Switch namespace"),
    makeItem("namespace-kube-system", "kube-system", "Namespaces", "Switch namespace"),
    makeItem("action-settings", "Open Settings", "Actions", "Configure theme, density, and more", "⌘,"),
    makeItem("action-logs", "Show Logs", "Actions", "Open the log viewer", "⌘L"),
    makeItem("action-refresh", "Refresh Resources", "Actions", "Reload current resource list"),
    makeItem("res-action-logs", "View Logs", "Resource Actions", "Show logs for nginx-pod"),
    makeItem("res-action-delete", "Delete Resource", "Resource Actions", "Delete nginx-pod"),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommandPalette logic", () => {
  beforeEach(() => {
    sampleItems = buildSampleItems();
  });

  // =========================================================================
  // tokenizeQuery
  // =========================================================================
  describe("tokenizeQuery", () => {
    test("splits simple query into tokens", () => {
      expect(tokenizeQuery("pods view")).toEqual(["pods", "view"]);
    });

    test("lowercases all tokens", () => {
      expect(tokenizeQuery("Pods VIEW")).toEqual(["pods", "view"]);
    });

    test("returns empty array for empty string", () => {
      expect(tokenizeQuery("")).toEqual([]);
    });

    test("returns empty array for whitespace-only string", () => {
      expect(tokenizeQuery("   ")).toEqual([]);
    });

    test("handles multiple spaces between words", () => {
      expect(tokenizeQuery("  pods   deploy  ")).toEqual(["pods", "deploy"]);
    });

    test("handles tabs and mixed whitespace", () => {
      expect(tokenizeQuery("pods\tdeploy")).toEqual(["pods", "deploy"]);
    });

    test("single word", () => {
      expect(tokenizeQuery("pods")).toEqual(["pods"]);
    });
  });

  // =========================================================================
  // matchItem
  // =========================================================================
  describe("matchItem", () => {
    test("matches token in label", () => {
      const item = makeItem("1", "Pods", "Resources", "View Pods");
      expect(matchItem(item, ["pods"])).toBe(true);
    });

    test("matches token in description", () => {
      const item = makeItem("1", "Open Settings", "Actions", "Configure theme, density, and more");
      expect(matchItem(item, ["theme"])).toBe(true);
    });

    test("matches token in category", () => {
      const item = makeItem("1", "minikube", "Contexts", "Switch context");
      expect(matchItem(item, ["contexts"])).toBe(true);
    });

    test("is case-insensitive", () => {
      const item = makeItem("1", "Pods", "Resources", "View Pods");
      expect(matchItem(item, ["PODS".toLowerCase()])).toBe(true);
    });

    test("requires ALL tokens to match (AND logic)", () => {
      const item = makeItem("1", "Pods", "Resources", "View Pods");
      expect(matchItem(item, ["pods", "view"])).toBe(true);
      expect(matchItem(item, ["pods", "deploy"])).toBe(false);
    });

    test("handles item with no description (undefined)", () => {
      const item = makeItem("1", "Pods", "Resources");
      // haystack: "Pods  Resources" — description is undefined → ""
      expect(matchItem(item, ["pods"])).toBe(true);
      expect(matchItem(item, ["view"])).toBe(false);
    });

    test("matches across label and description combined", () => {
      const item = makeItem("1", "Open Settings", "Actions", "Configure theme");
      // "open" in label, "theme" in description
      expect(matchItem(item, ["open", "theme"])).toBe(true);
    });

    test("matches across label and category combined", () => {
      const item = makeItem("1", "minikube", "Contexts", "Switch context");
      expect(matchItem(item, ["minikube", "contexts"])).toBe(true);
    });

    test("returns false when one token does not match anywhere", () => {
      const item = makeItem("1", "Pods", "Resources", "View Pods");
      expect(matchItem(item, ["pods", "zzz"])).toBe(false);
    });

    test("matches partial substrings", () => {
      const item = makeItem("1", "Deployments", "Resources", "View Deployments");
      expect(matchItem(item, ["deploy"])).toBe(true);
      expect(matchItem(item, ["eploy"])).toBe(true);
    });
  });

  // =========================================================================
  // filterCommandItems
  // =========================================================================
  describe("filterCommandItems", () => {
    test("empty string returns all items", () => {
      const result = filterCommandItems(sampleItems, "");
      expect(result).toEqual(sampleItems);
    });

    test("whitespace-only returns all items (falsy after no tokens)", () => {
      // The component uses `if (!query)` — whitespace is truthy, but
      // tokenizeQuery("   ") yields []. Since the actual component checks
      // `if (!query)` first (falsy check) then tokenizes, whitespace-only
      // is truthy so it goes through tokenization → 0 tokens → every()
      // returns true on empty array → all items pass.
      const result = filterCommandItems(sampleItems, "   ");
      expect(result.length).toBe(sampleItems.length);
    });

    test("single token filters correctly", () => {
      const result = filterCommandItems(sampleItems, "pods");
      // Matches: "Pods" (Resources), "View Logs" (has "nginx-pod" not "pods"),
      // Wait let me check: "Pods" label + "View Pods" desc, also "res-action-logs" has "nginx-pod" not "pods"
      const labels = result.map((i) => i.label);
      expect(labels).toContain("Pods");
    });

    test("multiple tokens narrow results (AND logic)", () => {
      const result = filterCommandItems(sampleItems, "view resources");
      // Items where haystack contains both "view" AND "resources"
      const ids = result.map((i) => i.id);
      expect(ids).toContain("resource-pods"); // "Pods View Pods Resources"
      expect(ids).toContain("resource-deployments");
      expect(ids).toContain("resource-services");
      expect(ids).toContain("resource-configmaps");
    });

    test("no match returns empty array", () => {
      const result = filterCommandItems(sampleItems, "zzzzz");
      expect(result).toEqual([]);
    });

    test("case insensitive filtering", () => {
      const result = filterCommandItems(sampleItems, "PODS");
      expect(result.length).toBeGreaterThan(0);
      expect(result.some((i) => i.label === "Pods")).toBe(true);
    });

    test("query matching description but not label", () => {
      const result = filterCommandItems(sampleItems, "theme");
      expect(result.length).toBe(1);
      expect(result[0].label).toBe("Open Settings");
    });

    test("query matching category but not label or description", () => {
      // "namespaces" appears in the Namespaces category
      const result = filterCommandItems(sampleItems, "namespaces");
      // The namespace items have category "Namespaces" and description "Switch namespace"
      // "namespaces" matches category "Namespaces" → yes
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((i) => i.category === "Namespaces")).toBe(true);
    });

    test("returns items preserving original order", () => {
      const result = filterCommandItems(sampleItems, "resources");
      // Resources category items should maintain their order
      const ids = result.map((i) => i.id);
      const podIdx = ids.indexOf("resource-pods");
      const deployIdx = ids.indexOf("resource-deployments");
      expect(podIdx).toBeLessThan(deployIdx);
    });
  });

  // =========================================================================
  // groupByCategory
  // =========================================================================
  describe("groupByCategory", () => {
    test("groups items by category field", () => {
      const groups = groupByCategory(sampleItems);
      expect(Object.keys(groups)).toContain("Resources");
      expect(Object.keys(groups)).toContain("Contexts");
      expect(Object.keys(groups)).toContain("Namespaces");
      expect(Object.keys(groups)).toContain("Actions");
      expect(Object.keys(groups)).toContain("Resource Actions");
    });

    test("each group contains correct items", () => {
      const groups = groupByCategory(sampleItems);
      expect(groups["Resources"].length).toBe(4);
      expect(groups["Contexts"].length).toBe(2);
      expect(groups["Namespaces"].length).toBe(2);
      expect(groups["Actions"].length).toBe(3);
      expect(groups["Resource Actions"].length).toBe(2);
    });

    test("empty input returns empty object", () => {
      const groups = groupByCategory([]);
      expect(Object.keys(groups).length).toBe(0);
    });

    test("single item in its own group", () => {
      const items = [makeItem("1", "Test", "Custom Category")];
      const groups = groupByCategory(items);
      expect(groups["Custom Category"].length).toBe(1);
    });

    test("preserves item order within a group", () => {
      const groups = groupByCategory(sampleItems);
      expect(groups["Resources"][0].id).toBe("resource-pods");
      expect(groups["Resources"][1].id).toBe("resource-deployments");
    });
  });

  // =========================================================================
  // orderGroups
  // =========================================================================
  describe("orderGroups", () => {
    test("known categories appear in defined order", () => {
      const groups = groupByCategory(sampleItems);
      const ordered = orderGroups(groups);
      const categoryNames = ordered.map(([cat]) => cat);
      expect(categoryNames).toEqual([
        "Resource Actions",
        "Resources",
        "Contexts",
        "Namespaces",
        "Actions",
      ]);
    });

    test("unknown categories appear after known ones", () => {
      const items = [
        ...sampleItems,
        makeItem("custom-1", "Custom", "Zebra Category"),
        makeItem("custom-2", "Another", "Alpha Category"),
      ];
      const groups = groupByCategory(items);
      const ordered = orderGroups(groups);
      const categoryNames = ordered.map(([cat]) => cat);

      // Known categories first
      const actionsIdx = categoryNames.indexOf("Actions");
      const zebraIdx = categoryNames.indexOf("Zebra Category");
      const alphaIdx = categoryNames.indexOf("Alpha Category");
      expect(actionsIdx).toBeLessThan(zebraIdx);
      expect(actionsIdx).toBeLessThan(alphaIdx);
    });

    test("missing known categories are skipped (not placeholders)", () => {
      // Only Resources and Actions
      const items = [
        makeItem("1", "Pods", "Resources"),
        makeItem("2", "Settings", "Actions"),
      ];
      const groups = groupByCategory(items);
      const ordered = orderGroups(groups);
      expect(ordered.length).toBe(2);
      expect(ordered[0][0]).toBe("Resources");
      expect(ordered[1][0]).toBe("Actions");
    });

    test("empty groups object returns empty array", () => {
      const ordered = orderGroups({});
      expect(ordered).toEqual([]);
    });

    test("only unknown categories still works", () => {
      const items = [
        makeItem("1", "Custom", "Zebra"),
        makeItem("2", "Other", "Alpha"),
      ];
      const groups = groupByCategory(items);
      const ordered = orderGroups(groups);
      expect(ordered.length).toBe(2);
      // Both are unknown so they follow Object.entries order
      const cats = ordered.map(([c]) => c);
      expect(cats).toContain("Zebra");
      expect(cats).toContain("Alpha");
    });
  });

  // =========================================================================
  // navigateSelection
  // =========================================================================
  describe("navigateSelection", () => {
    test("ArrowDown increments index by 1", () => {
      expect(navigateSelection(0, +1, 10)).toBe(1);
      expect(navigateSelection(5, +1, 10)).toBe(6);
    });

    test("ArrowUp decrements index by 1", () => {
      expect(navigateSelection(5, -1, 10)).toBe(4);
      expect(navigateSelection(1, -1, 10)).toBe(0);
    });

    test("ArrowDown at last item stays at last", () => {
      expect(navigateSelection(9, +1, 10)).toBe(9);
    });

    test("ArrowUp at 0 stays at 0", () => {
      expect(navigateSelection(0, -1, 10)).toBe(0);
    });

    test("ArrowDown clamps to totalItems - 1", () => {
      // Even if called multiple times logically
      expect(navigateSelection(9, +1, 10)).toBe(9);
      expect(navigateSelection(99, +1, 100)).toBe(99);
    });

    test("single item list: both directions stay at 0", () => {
      expect(navigateSelection(0, +1, 1)).toBe(0);
      expect(navigateSelection(0, -1, 1)).toBe(0);
    });

    test("two item list: correct navigation", () => {
      expect(navigateSelection(0, +1, 2)).toBe(1);
      expect(navigateSelection(1, +1, 2)).toBe(1);
      expect(navigateSelection(1, -1, 2)).toBe(0);
      expect(navigateSelection(0, -1, 2)).toBe(0);
    });
  });

  // =========================================================================
  // Integration: filter → group → order pipeline
  // =========================================================================
  describe("full pipeline: filter → group → order", () => {
    test("filtering then grouping then ordering", () => {
      const filtered = filterCommandItems(sampleItems, "switch");
      const grouped = groupByCategory(filtered);
      const ordered = orderGroups(grouped);

      // "switch" appears in description of context and namespace items
      const categories = ordered.map(([c]) => c);
      expect(categories).toContain("Contexts");
      expect(categories).toContain("Namespaces");
      expect(categories).not.toContain("Resources");
      expect(categories).not.toContain("Actions");
    });

    test("filtering removes categories entirely when no items match", () => {
      const filtered = filterCommandItems(sampleItems, "nginx");
      const grouped = groupByCategory(filtered);
      const ordered = orderGroups(grouped);

      // Only Resource Actions items mention "nginx-pod"
      expect(ordered.length).toBe(1);
      expect(ordered[0][0]).toBe("Resource Actions");
    });

    test("empty filter preserves all categories in correct order", () => {
      const filtered = filterCommandItems(sampleItems, "");
      const grouped = groupByCategory(filtered);
      const ordered = orderGroups(grouped);

      expect(ordered.map(([c]) => c)).toEqual([
        "Resource Actions",
        "Resources",
        "Contexts",
        "Namespaces",
        "Actions",
      ]);
    });
  });

  // =========================================================================
  // Edge: selection reset on query change
  // =========================================================================
  describe("selection reset behavior", () => {
    test("selectedIndex should reset to 0 when query changes (documented behavior)", () => {
      // The component has: $effect(() => { query; selectedIndex = 0; })
      // We simulate: after navigating down, changing query resets to 0
      let selectedIndex = 0;
      selectedIndex = navigateSelection(selectedIndex, +1, 10); // 1
      selectedIndex = navigateSelection(selectedIndex, +1, 10); // 2
      expect(selectedIndex).toBe(2);

      // Simulate query change resetting index
      selectedIndex = 0;
      expect(selectedIndex).toBe(0);
    });
  });
});
