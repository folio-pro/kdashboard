import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { orderedPodConditions, podOwner, podProblem, podReadyCount, podRestarts, podStatus } from "./pod-status";

function pod(partial: {
  phase?: string;
  reason?: string;
  deleting?: boolean;
  containers?: unknown[];
  init?: unknown[];
  conditions?: unknown[];
  owners?: Array<{ kind: string; name: string; controller?: boolean }>;
  specContainers?: number;
}): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name: "p",
      namespace: "ns",
      uid: "u",
      creation_timestamp: "",
      deletion_timestamp: partial.deleting ? "2024-01-01T00:00:00Z" : null,
      labels: {},
      annotations: {},
      resource_version: "1",
      owner_references: (partial.owners ?? []).map((o) => ({ api_version: "apps/v1", uid: "o", ...o })),
    },
    spec: { containers: Array.from({ length: partial.specContainers ?? 0 }, (_, i) => ({ name: `c${i}` })) },
    status: {
      phase: partial.phase ?? "Running",
      ...(partial.reason ? { reason: partial.reason } : {}),
      ...(partial.containers ? { containerStatuses: partial.containers } : {}),
      ...(partial.init ? { initContainerStatuses: partial.init } : {}),
      ...(partial.conditions ? { conditions: partial.conditions } : {}),
    },
  };
}

const running = (name = "app", ready = true) => ({ name, ready, restartCount: 0, state: { running: { startedAt: "t" } } });

describe("podStatus", () => {
  test("a healthy pod is Running", () => {
    expect(podStatus(pod({ containers: [running()] }))).toEqual({ label: "Running" });
  });

  test("a waiting container's reason wins over phase Running", () => {
    const p = pod({ containers: [running("sidecar"), { name: "app", ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } }] });
    expect(podStatus(p).label).toBe("CrashLoopBackOff");
  });

  test("ImagePullBackOff on a Pending pod", () => {
    const p = pod({ phase: "Pending", containers: [{ name: "app", ready: false, state: { waiting: { reason: "ImagePullBackOff" } } }] });
    expect(podStatus(p).label).toBe("ImagePullBackOff");
  });

  test("init containers: progress, then a failing one", () => {
    const pending = pod({
      phase: "Pending",
      init: [{ name: "i0", state: { terminated: { exitCode: 0 } } }, { name: "i1", state: { waiting: { reason: "PodInitializing" } } }],
    });
    expect(podStatus(pending).label).toBe("Init:1/2");
    const failing = pod({
      phase: "Pending",
      init: [{ name: "i0", state: { waiting: { reason: "CrashLoopBackOff" } } }],
    });
    expect(podStatus(failing).label).toBe("Init:CrashLoopBackOff");
    const crashed = pod({ phase: "Pending", init: [{ name: "i0", state: { terminated: { exitCode: 1 } } }] });
    expect(podStatus(crashed).label).toBe("Init:ExitCode:1");
  });

  test("a started sidecar init container does not block", () => {
    const p = pod({
      init: [{ name: "proxy", started: true, state: { running: {} } }],
      containers: [running()],
    });
    expect(podStatus(p).label).toBe("Running");
  });

  test("terminated containers: Completed, Error, or the exit code", () => {
    expect(podStatus(pod({ phase: "Succeeded", containers: [{ name: "job", ready: false, state: { terminated: { reason: "Completed", exitCode: 0 } } }] })).label).toBe("Completed");
    expect(podStatus(pod({ phase: "Failed", containers: [{ name: "job", ready: false, state: { terminated: { reason: "Error", exitCode: 1 } } }] })).label).toBe("Error");
    expect(podStatus(pod({ phase: "Failed", containers: [{ name: "job", ready: false, state: { terminated: { exitCode: 137 } } }] })).label).toBe("ExitCode:137");
    expect(podStatus(pod({ phase: "Failed", containers: [{ name: "job", ready: false, state: { terminated: { exitCode: 0, signal: 9 } } }] })).label).toBe("Signal:9");
  });

  test("a Completed main container next to a running one reads Running / NotReady", () => {
    const base = { containers: [{ name: "job", ready: false, state: { terminated: { reason: "Completed", exitCode: 0 } } }, running("sidecar")] };
    expect(podStatus(pod({ ...base, conditions: [{ type: "Ready", status: "True" }] })).label).toBe("Running");
    expect(podStatus(pod({ ...base, conditions: [{ type: "Ready", status: "False" }] })).label).toBe("NotReady");
  });

  test("deletion timestamp means Terminating, unless the node is lost", () => {
    expect(podStatus(pod({ deleting: true, containers: [running()] })).label).toBe("Terminating");
    expect(podStatus(pod({ deleting: true, reason: "NodeLost", containers: [running()] })).label).toBe("Unknown");
  });

  test("status.reason (Evicted) replaces the phase", () => {
    expect(podStatus(pod({ phase: "Failed", reason: "Evicted" })).label).toBe("Evicted");
  });

  test("a Pending pod carries the scheduler's reason", () => {
    const p = pod({ phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes" }] });
    expect(podStatus(p)).toEqual({ label: "Pending", reason: "Unschedulable" });
  });
});

describe("podReadyCount / podRestarts / podOwner", () => {
  test("ready fraction from statuses, spec fallback before statuses exist", () => {
    expect(podReadyCount(pod({ containers: [running("a"), running("b", false)] }))).toEqual({ ready: 1, total: 2 });
    expect(podReadyCount(pod({ phase: "Pending", specContainers: 2 }))).toEqual({ ready: 0, total: 2 });
  });

  test("restarts sum across init and app containers; lastAt is the newest termination", () => {
    const p = pod({
      init: [{ name: "i", restartCount: 1, lastState: { terminated: { finishedAt: "2024-01-01T00:00:00Z" } } }],
      containers: [
        { name: "a", restartCount: 3, lastState: { terminated: { finishedAt: "2024-01-02T00:00:00Z" } } },
        { name: "b", restartCount: 0 },
      ],
    });
    expect(podRestarts(p)).toEqual({ count: 4, lastAt: "2024-01-02T00:00:00Z" });
    expect(podRestarts(pod({ containers: [running()] }))).toEqual({ count: 0, lastAt: null });
  });

  test("owner prefers the controller reference and abbreviates the kind", () => {
    expect(podOwner(pod({ owners: [{ kind: "ConfigMap", name: "x" }, { kind: "ReplicaSet", name: "api-7d9f", controller: true }] }))).toEqual({ kind: "ReplicaSet", name: "api-7d9f", short: "rs" });
    expect(podOwner(pod({ owners: [{ kind: "StatefulSet", name: "db" }] }))?.short).toBe("sts");
    expect(podOwner(pod({ owners: [{ kind: "Foo", name: "f" }] }))?.short).toBe("foo");
    expect(podOwner(pod({}))).toBeNull();
  });
});

describe("podProblem", () => {
  test("null for a healthy or finished pod", () => {
    expect(podProblem(pod({ containers: [running()] }))).toBeNull();
    expect(podProblem(pod({ phase: "Succeeded", containers: [{ name: "j", state: { terminated: { reason: "Completed", exitCode: 0 } } }] }))).toBeNull();
  });

  test("a crash-looping container, with its last termination", () => {
    const p = pod({
      containers: [
        running("sidecar"),
        {
          name: "app", ready: false, restartCount: 7,
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s" } },
          lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: "2024-01-02T00:00:00Z" } },
        },
      ],
    });
    expect(podProblem(p)).toEqual({
      container: "app", init: false, reason: "CrashLoopBackOff", message: "back-off 5m0s",
      exitCode: 1, lastReason: "Error", lastFinishedAt: "2024-01-02T00:00:00Z", restartCount: 7,
    });
  });

  test("a failed init container comes first", () => {
    const p = pod({
      init: [{ name: "migrate", restartCount: 2, state: { terminated: { reason: "Error", exitCode: 2, finishedAt: "t" } } }],
      containers: [{ name: "app", state: { waiting: { reason: "PodInitializing" } } }],
    });
    expect(podProblem(p)).toMatchObject({ container: "migrate", init: true, reason: "Error", exitCode: 2 });
  });

  test("an unschedulable pod names the scheduler's reason", () => {
    const p = pod({ phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available: 3 Insufficient cpu." }] });
    expect(podProblem(p)).toEqual({ reason: "Unschedulable", message: "0/3 nodes are available: 3 Insufficient cpu.", restartCount: 0 });
  });

  test("ContainerCreating is not a problem", () => {
    expect(podProblem(pod({ phase: "Pending", containers: [{ name: "app", state: { waiting: { reason: "ContainerCreating" } } }] }))).toBeNull();
  });
});

describe("orderedPodConditions", () => {
  test("lifecycle order regardless of API order", () => {
    const p = pod({ conditions: [{ type: "Ready", status: "False" }, { type: "Custom", status: "True" }, { type: "PodScheduled", status: "True" }, { type: "ContainersReady", status: "False" }] });
    expect(orderedPodConditions(p).map((c) => c.type)).toEqual(["PodScheduled", "ContainersReady", "Ready", "Custom"]);
  });
});
