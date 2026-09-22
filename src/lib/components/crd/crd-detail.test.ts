import { describe, expect, test } from "bun:test";
import { resolveCrdDetail } from "./crd-detail.js";
import type { Resource } from "$lib/types/index.js";

function res(uid: string, phase = "Pending"): Resource {
  return {
    kind: "Certificate",
    api_version: "cert-manager.io/v1",
    metadata: { name: `cert-${uid}`, uid },
    spec: {},
    status: { phase },
  } as unknown as Resource;
}

describe("resolveCrdDetail", () => {
  test("no uid means no detail", () => {
    expect(resolveCrdDetail([res("a")], null, null, false)).toEqual({ resource: null, deleted: false });
  });

  test("follows the live item with the same uid, not the snapshot", () => {
    const snapshot = res("a", "Pending");
    const live = res("a", "Ready");
    const out = resolveCrdDetail([res("b"), live], "a", snapshot, false);
    expect(out.resource).toBe(live);
    expect(out.deleted).toBe(false);
  });

  test("a vanished object falls back to the snapshot and is flagged deleted", () => {
    const snapshot = res("a");
    const out = resolveCrdDetail([res("b")], "a", snapshot, false);
    expect(out.resource).toBe(snapshot);
    expect(out.deleted).toBe(true);
  });

  test("while the list is loading a missing object is not reported deleted", () => {
    const snapshot = res("a");
    const out = resolveCrdDetail([], "a", snapshot, true);
    expect(out.resource).toBe(snapshot);
    expect(out.deleted).toBe(false);
  });

  test("a vanished object with no snapshot yields no resource", () => {
    expect(resolveCrdDetail([], "a", null, false)).toEqual({ resource: null, deleted: true });
  });
});
