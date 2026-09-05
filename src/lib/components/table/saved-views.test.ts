import { describe, expect, test } from "bun:test";
import { builtinViews, viewsFor, isViewActive, viewFromState, isEmptyState } from "./saved-views";
import type { SavedView } from "$lib/types/ui";

describe("saved views", () => {
  test("pods ship All / Attention / Restarting", () => {
    expect(builtinViews("pods").map((v) => v.id)).toEqual(["all", "attention", "restarting"]);
    expect(builtinViews("pods").every((v) => v.builtin && v.resourceType === "pods")).toBe(true);
  });
  test("unknown types get only All", () => {
    expect(builtinViews("configmaps").map((v) => v.id)).toEqual(["all"]);
  });
  test("custom views for the type follow the built-ins", () => {
    const saved: SavedView[] = [
      { id: "x", name: "Mine", resourceType: "pods", facets: [] },
      { id: "y", name: "Other", resourceType: "nodes", facets: [] },
    ];
    expect(viewsFor("pods", saved).map((v) => v.id)).toEqual(["all", "attention", "restarting", "x"]);
  });
  test("All is active when nothing filters", () => {
    const [all] = builtinViews("pods");
    expect(isViewActive(all, { facets: [], text: "", statFilter: null })).toBe(true);
    expect(isViewActive(all, { facets: [], text: "api", statFilter: null })).toBe(false);
  });
  test("Restarting matches its facet regardless of order", () => {
    const restarting = builtinViews("pods")[2];
    expect(isViewActive(restarting, { facets: [{ key: "restarts", op: ">", value: "0" }], text: "", statFilter: null })).toBe(true);
    expect(isViewActive(restarting, { facets: [{ key: "restarts", op: ">", value: "1" }], text: "", statFilter: null })).toBe(false);
  });
  test("viewFromState copies facets and trims the name", () => {
    const v = viewFromState("  Prod errors ", "pods", { facets: [{ key: "status", op: "!:", value: "running" }], text: "prod", statFilter: null });
    expect(v.name).toBe("Prod errors");
    expect(v.resourceType).toBe("pods");
    expect(v.facets).toEqual([{ key: "status", op: "!:", value: "running" }]);
    expect(v.text).toBe("prod");
    expect(v.builtin).toBeUndefined();
  });
  test("isEmptyState", () => {
    expect(isEmptyState({ facets: [], text: "", statFilter: null })).toBe(true);
    expect(isEmptyState({ facets: [], text: "", statFilter: "running" })).toBe(false);
  });
});
