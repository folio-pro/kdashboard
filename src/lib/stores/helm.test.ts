import { describe, expect, test } from "bun:test";
import { HelmStoreLogic } from "./helm.logic";
import type { HelmRelease, HelmReleaseDetail } from "$lib/types";

const release = (name: string, namespace: string) => ({ name, namespace }) as HelmRelease;
const detail = (name: string) => ({ name }) as unknown as HelmReleaseDetail;

describe("HelmStoreLogic stale responses", () => {
  test("a list load overtaken by a newer one is dropped", () => {
    const store = new HelmStoreLogic();
    const first = store.beginListLoad();
    const second = store.beginListLoad();
    store.applyReleases([release("web", "shop")], second);
    store.applyReleases([release("api", "default")], first);
    expect(store.releases.map((r) => r.name)).toEqual(["web"]);
  });

  test("a failed list load overtaken by a newer one sets no error", () => {
    const store = new HelmStoreLogic();
    const first = store.beginListLoad();
    const second = store.beginListLoad();
    store.applyReleases([], second);
    store.applyError("forbidden", first);
    expect(store.error).toBeNull();
  });

  test("the current list load applies", () => {
    const store = new HelmStoreLogic();
    const token = store.beginListLoad();
    expect(store.isCurrentListLoad(token)).toBe(true);
    store.applyReleases([release("web", "shop")], token);
    expect(store.releases).toHaveLength(1);
    expect(store.loaded).toBe(true);
  });

  test("a release detail that lands after clearSelection is dropped", () => {
    const store = new HelmStoreLogic();
    const token = store.beginDetailLoad();
    store.clearSelection();
    store.applyDetail(detail("web"), [release("web", "default")], token);
    expect(store.selected).toBeNull();
    expect(store.history).toEqual([]);
  });

  test("a release detail overtaken by a newer pick is dropped", () => {
    const store = new HelmStoreLogic();
    const first = store.beginDetailLoad();
    const second = store.beginDetailLoad();
    store.applyDetail(detail("api"), [], second);
    store.applyDetail(detail("web"), [], first);
    expect(store.selected).toEqual(detail("api"));
  });

  test("a list load does not invalidate an open release, nor the reverse", () => {
    const store = new HelmStoreLogic();
    const list = store.beginListLoad();
    const pick = store.beginDetailLoad();
    store.applyDetail(detail("web"), [], pick);
    store.applyReleases([release("web", "default")], list);
    expect(store.selected).toEqual(detail("web"));
    expect(store.releases).toHaveLength(1);
  });

  test("reset drops every in-flight load", () => {
    const store = new HelmStoreLogic();
    const list = store.beginListLoad();
    const pick = store.beginDetailLoad();
    store.reset();
    store.applyReleases([release("web", "default")], list);
    store.applyDetail(detail("web"), [], pick);
    expect(store.releases).toEqual([]);
    expect(store.selected).toBeNull();
    expect(store.loaded).toBe(false);
  });
});
