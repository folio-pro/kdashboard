import { describe, expect, mock, test } from "bun:test";
import type { Resource } from "$lib/types";
import {
  performRollback,
  resourceKey,
  type RevisionInfo,
} from "./revision-history-card.logic";

function makeResource(name: string, namespace?: string): Resource {
  return {
    kind: "Deployment",
    api_version: "apps/v1",
    metadata: {
      name,
      namespace,
      uid: "u-1",
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: {},
  };
}

function makeRevision(rev: number, overrides: Partial<RevisionInfo> = {}): RevisionInfo {
  return {
    revision: rev,
    name: `rs-${rev}`,
    created_at: "2026-01-01T00:00:00Z",
    images: ["nginx:1.25"],
    replicas: 3,
    is_current: false,
    ...overrides,
  };
}

describe("resourceKey", () => {
  test("combines namespace and name", () => {
    expect(resourceKey({ metadata: { name: "nginx", namespace: "default" } })).toBe(
      "default:nginx",
    );
  });

  test("falls back to empty string when namespace is missing", () => {
    expect(resourceKey({ metadata: { name: "cluster-role" } })).toBe(":cluster-role");
  });

  test("distinguishes same name across namespaces", () => {
    const a = resourceKey({ metadata: { name: "api", namespace: "prod" } });
    const b = resourceKey({ metadata: { name: "api", namespace: "staging" } });
    expect(a).not.toBe(b);
  });
});

describe("performRollback", () => {
  test("calls rollback with the target revision, refreshes, and returns ok=true", async () => {
    const resource = makeResource("nginx", "default");
    const target = makeRevision(3);
    const newRevisions = [makeRevision(4, { is_current: true }), makeRevision(3)];

    const rollback = mock(() => Promise.resolve());
    const fetchRevisions = mock(() => Promise.resolve(newRevisions));
    const notifyError = mock(() => {});

    const result = await performRollback(resource, target, {
      rollback,
      fetchRevisions,
      notifyError,
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith(resource, 3);
    expect(fetchRevisions).toHaveBeenCalledTimes(1);
    expect(notifyError).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, revisions: newRevisions, error: null });
  });

  test("captures the revision from target, not from a mutating caller", async () => {
    // Regression: pendingRevision used to be read inside the async body, meaning
    // a quick click-another-revision could roll back the wrong one. The extracted
    // logic captures `target` explicitly; this test pins that invariant.
    const resource = makeResource("nginx");
    const target = makeRevision(7);

    const observedRevisions: number[] = [];
    const rollback = mock((_r: Resource, rev: number) => {
      observedRevisions.push(rev);
      return Promise.resolve();
    });
    const fetchRevisions = mock(() => Promise.resolve([]));
    const notifyError = mock(() => {});

    await performRollback(resource, target, { rollback, fetchRevisions, notifyError });

    expect(observedRevisions).toEqual([7]);
  });

  test("notifies and returns ok=false when rollback throws", async () => {
    const resource = makeResource("api");
    const target = makeRevision(2);

    const rollback = mock(() => Promise.reject(new Error("connection refused")));
    const fetchRevisions = mock(() => Promise.resolve([]));
    const notifyError = mock(() => {});

    const result = await performRollback(resource, target, {
      rollback,
      fetchRevisions,
      notifyError,
    });

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(
      "Rollback failed",
      expect.stringContaining("connection refused"),
    );
    expect(fetchRevisions).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.revisions).toBeNull();
    expect(result.error).toContain("connection refused");
  });

  test("notifies and returns ok=false when refetch throws after a successful rollback", async () => {
    const resource = makeResource("api");
    const target = makeRevision(2);

    const rollback = mock(() => Promise.resolve());
    const fetchRevisions = mock(() => Promise.reject(new Error("apiserver 503")));
    const notifyError = mock(() => {});

    const result = await performRollback(resource, target, {
      rollback,
      fetchRevisions,
      notifyError,
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("apiserver 503");
  });

  test("String() of a non-Error rejection value still reaches notifyError", async () => {
    const resource = makeResource("api");
    const target = makeRevision(1);

    const rollback = mock(() => Promise.reject("plain string failure"));
    const fetchRevisions = mock(() => Promise.resolve([]));
    const notifyError = mock(() => {});

    const result = await performRollback(resource, target, {
      rollback,
      fetchRevisions,
      notifyError,
    });

    expect(notifyError).toHaveBeenCalledWith("Rollback failed", "plain string failure");
    expect(result.error).toBe("plain string failure");
  });
});
