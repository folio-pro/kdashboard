import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { deploymentStatus, replicaSegments, shortImage, templateImages } from "./workload-status";

function deploy(spec: Record<string, unknown>, status: Record<string, unknown> = {}): Resource {
  return {
    kind: "Deployment",
    api_version: "apps/v1",
    metadata: { name: "d", namespace: "ns", uid: "u", creation_timestamp: "", labels: {}, annotations: {}, resource_version: "1", owner_references: [] },
    spec,
    status,
  };
}

const avail = (status: string, reason?: string) => ({ type: "Available", status, reason });
const prog = (status: string, reason?: string) => ({ type: "Progressing", status, reason });

describe("deploymentStatus", () => {
  test("Available when every replica is ready and up to date", () => {
    const d = deploy({ replicas: 3 }, { replicas: 3, readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3, conditions: [avail("True"), prog("True", "NewReplicaSetAvailable")] });
    expect(deploymentStatus(d)).toEqual({ label: "Available" });
  });

  test("Progressing while updated replicas trail the desired count", () => {
    const d = deploy({ replicas: 3 }, { replicas: 4, readyReplicas: 3, updatedReplicas: 1, conditions: [avail("True"), prog("True", "ReplicaSetUpdated")] });
    expect(deploymentStatus(d)).toEqual({ label: "Progressing", detail: "ReplicaSetUpdated" });
  });

  test("Unavailable carries the Available condition's reason", () => {
    const d = deploy({ replicas: 2 }, { replicas: 2, readyReplicas: 0, updatedReplicas: 2, conditions: [avail("False", "MinimumReplicasUnavailable"), prog("True")] });
    expect(deploymentStatus(d)).toEqual({ label: "Unavailable", detail: "MinimumReplicasUnavailable" });
  });

  test("a rollout past its deadline is Failed, a ReplicaFailure is its own word", () => {
    expect(deploymentStatus(deploy({ replicas: 2 }, { conditions: [prog("False", "ProgressDeadlineExceeded")] }))).toEqual({ label: "Failed", detail: "ProgressDeadlineExceeded" });
    expect(deploymentStatus(deploy({ replicas: 2 }, { conditions: [{ type: "ReplicaFailure", status: "True", reason: "FailedCreate" }] }))).toEqual({ label: "ReplicaFailure", detail: "FailedCreate" });
  });

  test("Paused and Scaled to 0 are deliberate states, checked first", () => {
    expect(deploymentStatus(deploy({ replicas: 4, paused: true }, { readyReplicas: 4, updatedReplicas: 4, replicas: 4 }))).toEqual({ label: "Paused" });
    expect(deploymentStatus(deploy({ replicas: 0 }, { conditions: [avail("False")] }))).toEqual({ label: "Scaled to 0" });
  });

  test("spec.replicas omitted defaults to 1", () => {
    expect(deploymentStatus(deploy({}, { replicas: 1, readyReplicas: 1, updatedReplicas: 1 }))).toEqual({ label: "Available" });
  });
});

describe("replicaSegments", () => {
  test("ready / pending / missing add up to the desired count", () => {
    expect(replicaSegments(deploy({ replicas: 3 }, { replicas: 3, readyReplicas: 2 }))).toEqual({ desired: 3, ready: 2, pending: 1, missing: 0 });
    expect(replicaSegments(deploy({ replicas: 3 }, { replicas: 1, readyReplicas: 0 }))).toEqual({ desired: 3, ready: 0, pending: 1, missing: 2 });
    expect(replicaSegments(deploy({ replicas: 2 }, {}))).toEqual({ desired: 2, ready: 0, pending: 0, missing: 2 });
  });

  test("a surplus during a rollout shows as pending, never negative", () => {
    expect(replicaSegments(deploy({ replicas: 3 }, { replicas: 4, readyReplicas: 3 }))).toEqual({ desired: 3, ready: 3, pending: 1, missing: 0 });
  });
});

describe("shortImage / templateImages", () => {
  test("drops registry and path, keeps the tag", () => {
    expect(shortImage("ghcr.io/shop/api:2.4.1")).toBe("api:2.4.1");
    expect(shortImage("nginx")).toBe("nginx");
    expect(shortImage("registry:5000/team/app:1.0")).toBe("app:1.0");
  });

  test("digest-pinned images keep a short digest", () => {
    expect(shortImage("ghcr.io/shop/api@sha256:0123456789abcdef")).toBe("api@0123456");
    expect(shortImage("ghcr.io/shop/api:2.4.1@sha256:0123456789abcdef")).toBe("api:2.4.1");
  });

  test("template images in container order", () => {
    const d = deploy({ template: { spec: { initContainers: [{ image: "busybox" }], containers: [{ image: "ghcr.io/shop/api:2.4.1" }, { image: "otel/collector:0.98.0" }] } } });
    expect(templateImages(d)).toEqual(["ghcr.io/shop/api:2.4.1", "otel/collector:0.98.0"]);
    expect(templateImages(deploy({}))).toEqual([]);
  });
});
