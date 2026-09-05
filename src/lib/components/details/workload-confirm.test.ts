import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import type { RevisionInfo } from "./revision-history-card.logic";
import { previousRevision, restartMessage, restartTitle, rollbackMessage } from "./workload-confirm.logic";

function res(kind: string, name: string): Resource {
  return {
    kind,
    api_version: "apps/v1",
    metadata: {
      name,
      namespace: "default",
      uid: `uid-${name}`,
      creation_timestamp: "2024-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: {},
  };
}

function rev(revision: number, images: string[], is_current = false): RevisionInfo {
  return { revision, name: `web-${revision}`, created_at: null, images, replicas: 1, is_current };
}

describe("restart copy", () => {
  test("single resource names the kind and the workload", () => {
    const r = [res("Deployment", "web-api")];
    expect(restartTitle(r)).toBe("Restart Deployment");
    expect(restartMessage(r)).toBe("Restart Deployment web-api? Pods will be recreated one by one.");
  });

  test("bulk of one kind counts them and lists the names", () => {
    const r = [res("Deployment", "a"), res("Deployment", "b"), res("Deployment", "c")];
    expect(restartTitle(r)).toBe("Restart 3 deployments");
    expect(restartMessage(r)).toBe("Restart 3 workloads (a, b, c)? Pods will be recreated one by one.");
  });

  test("bulk of mixed kinds says workloads and truncates a long list", () => {
    const r = [
      res("Deployment", "a"), res("StatefulSet", "b"), res("DaemonSet", "c"),
      res("Deployment", "d"), res("Deployment", "e"),
    ];
    expect(restartTitle(r)).toBe("Restart 5 workloads");
    expect(restartMessage(r)).toBe("Restart 5 workloads (a, b, c, d, …)? Pods will be recreated one by one.");
  });
});

describe("previousRevision", () => {
  test("is the second-newest revision — what rollback_deployment targets by default", () => {
    const revisions = [rev(3, ["nginx:1.28"], true), rev(2, ["nginx:1.27-alpine"]), rev(1, ["nginx:1.26"])];
    expect(previousRevision(revisions)?.revision).toBe(2);
  });

  test("is null with a single (or no) revision", () => {
    expect(previousRevision([rev(1, ["x"], true)])).toBeNull();
    expect(previousRevision([])).toBeNull();
  });
});

describe("rollbackMessage", () => {
  test("shows the target revision and its images", () => {
    expect(rollbackMessage("web-api", rev(2, ["nginx:1.27-alpine"]))).toBe(
      "Roll back web-api to revision #2 (nginx:1.27-alpine)? Running pods will be replaced with that revision's template.",
    );
  });

  test("omits the parenthesis when the revision has no images", () => {
    expect(rollbackMessage("web-api", rev(2, []))).toBe(
      "Roll back web-api to revision #2? Running pods will be replaced with that revision's template.",
    );
  });
});
