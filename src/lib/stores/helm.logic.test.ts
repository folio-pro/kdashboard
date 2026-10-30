import { describe, expect, test } from "bun:test";
import type { HelmRelease, HelmReleaseDetail } from "$lib/types";
import { HelmStoreLogic, filterReleases, releaseHealth } from "./helm.logic";

function rel(name: string, namespace = "default", chart = "nginx", revision = 1): HelmRelease {
  return {
    name,
    namespace,
    revision,
    status: "deployed",
    chart,
    chart_version: "1.0.0",
    app_version: "1.0",
    updated: "",
    description: "",
  };
}

function detail(name: string, revision = 1): HelmReleaseDetail {
  return { ...rel(name, "default", "nginx", revision), values: {}, chart_values: {}, manifest: "", notes: "" };
}

describe("releaseHealth", () => {
  test("maps helm statuses onto status buckets", () => {
    expect(releaseHealth("deployed")).toBe("ok");
    expect(releaseHealth("Superseded")).toBe("ok");
    expect(releaseHealth("pending-install")).toBe("pending");
    expect(releaseHealth("pending-upgrade")).toBe("pending");
    expect(releaseHealth("uninstalling")).toBe("pending");
    expect(releaseHealth("failed")).toBe("failed");
    expect(releaseHealth("uninstalled")).toBe("failed");
    expect(releaseHealth("unknown")).toBe("unknown");
    expect(releaseHealth("something-new")).toBe("unknown");
  });
});

describe("filterReleases", () => {
  const list = [rel("web", "prod", "nginx"), rel("db", "data", "postgresql"), rel("cache", "prod", "redis")];

  test("an empty or blank query returns the input", () => {
    expect(filterReleases(list, "")).toBe(list);
    expect(filterReleases(list, "   ")).toBe(list);
  });

  test("matches name, namespace and chart case-insensitively", () => {
    expect(filterReleases(list, "WEB").map((r) => r.name)).toEqual(["web"]);
    expect(filterReleases(list, "prod").map((r) => r.name)).toEqual(["web", "cache"]);
    expect(filterReleases(list, "postgres").map((r) => r.name)).toEqual(["db"]);
    expect(filterReleases(list, "nope")).toEqual([]);
  });
});

describe("HelmStoreLogic list loads", () => {
  test("a load sets and clears listLoading and applies the list", () => {
    const s = new HelmStoreLogic();
    const id = s.beginListLoad();
    expect(s.listLoading).toBe(true);
    s.applyReleasesIfCurrent(id, [rel("a")]);
    expect(s.listLoading).toBe(false);
    expect(s.loaded).toBe(true);
    expect(s.releases.map((r) => r.name)).toEqual(["a"]);
  });

  test("an out-of-order older response never overwrites a newer one", () => {
    const s = new HelmStoreLogic();
    const older = s.beginListLoad();
    const newer = s.beginListLoad();
    s.applyReleasesIfCurrent(newer, [rel("new")]);
    s.applyReleasesIfCurrent(older, [rel("old")]);
    expect(s.releases.map((r) => r.name)).toEqual(["new"]);
    s.applyListErrorIfCurrent(older, "boom");
    expect(s.listError).toBeNull();
  });

  test("an older response finishing first does not clear the newer load's spinner", () => {
    const s = new HelmStoreLogic();
    const older = s.beginListLoad();
    s.beginListLoad();
    s.applyReleasesIfCurrent(older, [rel("old")]);
    expect(s.listLoading).toBe(true);
    expect(s.releases).toEqual([]);
  });

  test("an error is recorded and a later success clears it", () => {
    const s = new HelmStoreLogic();
    s.applyListErrorIfCurrent(s.beginListLoad(), "forbidden");
    expect(s.listError).toBe("forbidden");
    expect(s.listLoading).toBe(false);
    s.applyReleasesIfCurrent(s.beginListLoad(), []);
    expect(s.listError).toBeNull();
  });

  test("applying reassigns the releases array rather than mutating it", () => {
    const s = new HelmStoreLogic();
    const before = s.releases;
    s.applyReleasesIfCurrent(s.beginListLoad(), [rel("a")]);
    expect(s.releases).not.toBe(before);
    expect(before).toEqual([]);
  });

  test("reset invalidates in-flight list loads", () => {
    const s = new HelmStoreLogic();
    const id = s.beginListLoad();
    s.reset();
    expect(s.listLoading).toBe(false);
    s.applyReleasesIfCurrent(id, [rel("late")]);
    s.applyListErrorIfCurrent(id, "late");
    expect(s.releases).toEqual([]);
    expect(s.listError).toBeNull();
    expect(s.loaded).toBe(false);
  });
});

describe("HelmStoreLogic detail loads", () => {
  test("detail state is separate from list state", () => {
    const s = new HelmStoreLogic();
    s.applyReleasesIfCurrent(s.beginListLoad(), [rel("a")]);
    const id = s.beginDetailLoad({ namespace: "default", name: "a" });
    expect(s.detailLoading).toBe(true);
    expect(s.listLoading).toBe(false);
    s.applyDetailErrorIfCurrent(id, "secret too large");
    expect(s.detailError).toBe("secret too large");
    expect(s.detailLoading).toBe(false);
    expect(s.listError).toBeNull();
    expect(s.releases.map((r) => r.name)).toEqual(["a"]);
  });

  test("list and detail loads do not cancel each other's spinner", () => {
    const s = new HelmStoreLogic();
    const list = s.beginListLoad();
    const det = s.beginDetailLoad({ namespace: "default", name: "a" });
    s.applyDetailIfCurrent(det, detail("a"), [rel("a")]);
    expect(s.listLoading).toBe(true);
    s.applyReleasesIfCurrent(list, [rel("a")]);
    expect(s.listLoading).toBe(false);
    expect(s.selected?.name).toBe("a");
  });

  test("a successful detail load applies detail and history and clears the error", () => {
    const s = new HelmStoreLogic();
    s.applyDetailErrorIfCurrent(s.beginDetailLoad({ namespace: "default", name: "a" }), "x");
    const id = s.beginDetailLoad({ namespace: "default", name: "a" });
    s.applyDetailIfCurrent(id, detail("a", 2), [rel("a", "default", "nginx", 2), rel("a")]);
    expect(s.detailError).toBeNull();
    expect(s.selected?.revision).toBe(2);
    expect(s.history).toHaveLength(2);
  });

  test("loading another revision keeps the current detail on screen until it lands", () => {
    const s = new HelmStoreLogic();
    s.applyDetailIfCurrent(s.beginDetailLoad({ namespace: "default", name: "a" }), detail("a", 3), []);
    s.beginDetailLoad({ namespace: "default", name: "a", revision: 2 });
    expect(s.detailLoading).toBe(true);
    expect(s.selected?.revision).toBe(3);
    expect(s.detailTarget).toEqual({ namespace: "default", name: "a", revision: 2 });
  });

  test("an out-of-order older detail response is dropped", () => {
    const s = new HelmStoreLogic();
    const older = s.beginDetailLoad({ namespace: "default", name: "a", revision: 1 });
    const newer = s.beginDetailLoad({ namespace: "default", name: "a", revision: 2 });
    s.applyDetailIfCurrent(newer, detail("a", 2), []);
    s.applyDetailIfCurrent(older, detail("a", 1), []);
    s.applyDetailErrorIfCurrent(older, "late");
    expect(s.selected?.revision).toBe(2);
    expect(s.detailError).toBeNull();
  });

  test("clearSelection clears the detail error and drops in-flight detail loads", () => {
    const s = new HelmStoreLogic();
    s.applyReleasesIfCurrent(s.beginListLoad(), [rel("a")]);
    s.applyDetailErrorIfCurrent(s.beginDetailLoad({ namespace: "default", name: "a" }), "gone");
    const pending = s.beginDetailLoad({ namespace: "default", name: "a" });
    s.clearSelection();
    expect(s.detailTarget).toBeNull();
    expect(s.detailError).toBeNull();
    expect(s.detailLoading).toBe(false);
    s.applyDetailIfCurrent(pending, detail("a"), []);
    expect(s.selected).toBeNull();
    expect(s.releases.map((r) => r.name)).toEqual(["a"]);
  });

  test("reset clears detail state and invalidates in-flight detail loads", () => {
    const s = new HelmStoreLogic();
    const id = s.beginDetailLoad({ namespace: "default", name: "a" });
    s.reset();
    s.applyDetailIfCurrent(id, detail("a"), [rel("a")]);
    expect(s.selected).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.detailTarget).toBeNull();
    expect(s.detailLoading).toBe(false);
  });
});
