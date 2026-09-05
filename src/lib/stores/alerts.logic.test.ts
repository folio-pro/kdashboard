import { describe, expect, test } from "bun:test";
import type { Event as K8sEvent, Resource, WatchedResource } from "$lib/types";
import { AlertMonitor, describeWatched, eventKey, healthOf } from "./alerts.logic";

function res(kind: string, extra: Partial<Resource> = {}): Resource {
  return {
    kind,
    api_version: "v1",
    metadata: {
      name: "web",
      namespace: "billing",
      uid: "u",
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: extra.spec ?? {},
    status: extra.status ?? {},
  };
}

const watched: WatchedResource = { id: "w1", context: "prod", kind: "Pod", name: "web", namespace: "billing" };

const runningPod = res("Pod", {
  status: { phase: "Running", containerStatuses: [{ name: "app", ready: true, restartCount: 0, state: { running: {} } }] },
});
const crashingPod = res("Pod", {
  status: {
    phase: "Running",
    containerStatuses: [
      { name: "app", ready: false, restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 40s" } }, lastState: { terminated: { exitCode: 1, reason: "Error" } } },
    ],
  },
});

describe("healthOf", () => {
  test("pods: broken containers and failed phases are unhealthy", () => {
    expect(healthOf(runningPod)).toEqual({ ok: true, label: "Running" });
    const bad = healthOf(crashingPod);
    expect(bad.ok).toBe(false);
    expect(bad.label).toBe("CrashLoopBackOff");
    expect(bad.detail).toBe("app: back-off 40s");
    expect(healthOf(res("Pod", { status: { phase: "Failed" } })).ok).toBe(false);
    expect(healthOf(res("Pod", { status: { phase: "Pending" } })).ok).toBe(true);
  });

  test("deployments: failed or unavailable rollouts alert, progressing does not", () => {
    const dep = (conditions: unknown[], replicas = 3, ready = 3) =>
      res("Deployment", { spec: { replicas }, status: { replicas, readyReplicas: ready, updatedReplicas: replicas, conditions } });
    expect(healthOf(dep([{ type: "Available", status: "True" }])).ok).toBe(true);
    expect(healthOf(dep([{ type: "Available", status: "True" }], 3, 1)).label).toBe("Progressing");
    expect(healthOf(dep([{ type: "Available", status: "True" }], 3, 1)).ok).toBe(true);
    expect(healthOf(dep([{ type: "Available", status: "False", reason: "MinimumReplicasUnavailable" }], 3, 0))).toEqual({
      ok: false,
      label: "Unavailable",
      detail: "MinimumReplicasUnavailable",
    });
    expect(healthOf(dep([{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }])).ok).toBe(false);
  });

  test("statefulsets, daemonsets, jobs and nodes", () => {
    expect(healthOf(res("StatefulSet", { spec: { replicas: 3 }, status: { readyReplicas: 2 } }))).toEqual({ ok: false, label: "2/3 ready" });
    expect(healthOf(res("StatefulSet", { spec: { replicas: 0 }, status: {} })).ok).toBe(true);
    expect(healthOf(res("DaemonSet", { status: { desiredNumberScheduled: 6, numberAvailable: 6 } })).ok).toBe(true);
    expect(healthOf(res("DaemonSet", { status: { desiredNumberScheduled: 6, numberAvailable: 5 } })).ok).toBe(false);
    expect(healthOf(res("Job", { status: { failed: 1 } })).ok).toBe(false);
    expect(healthOf(res("Job", { status: { conditions: [{ type: "Complete", status: "True" }] } })).label).toBe("Complete");
    expect(healthOf(res("Node", { status: { conditions: [{ type: "Ready", status: "True" }] } })).ok).toBe(true);
    expect(healthOf(res("Node", { status: { conditions: [{ type: "Ready", status: "True" }, { type: "MemoryPressure", status: "True" }] } })).label).toBe("MemoryPressure");
    expect(healthOf(res("Node", { status: { conditions: [{ type: "Ready", status: "False", reason: "KubeletNotReady" }] } }))).toEqual({ ok: false, label: "NotReady", detail: "KubeletNotReady" });
    expect(healthOf(res("ConfigMap")).ok).toBe(true);
  });
});

describe("eventKey / describeWatched", () => {
  test("repeats of an event get a new key when count or timestamp moves", () => {
    const e = (count: number, ts: string): K8sEvent => ({ type: "Warning", reason: "BackOff", message: "m", count, last_timestamp: ts });
    expect(eventKey(e(1, "t1"))).not.toBe(eventKey(e(2, "t2")));
    expect(eventKey(e(1, "t1"))).toBe(eventKey(e(1, "t1")));
  });
  test("describeWatched reads like kubectl", () => {
    expect(describeWatched(watched)).toBe("Pod billing/web");
    expect(describeWatched({ kind: "Node", name: "n1" })).toBe("Node n1");
  });
});

describe("AlertMonitor", () => {
  function monitor(script: { resource: Array<Resource | null | Error>; events?: K8sEvent[][] }) {
    let i = -1;
    let j = -1;
    const m = new AlertMonitor({
      getResource: async () => {
        i++;
        const r = script.resource[Math.min(i, script.resource.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
      getEvents: async () => {
        j++;
        const evs = script.events ?? [];
        return evs[Math.min(j, evs.length - 1)] ?? [];
      },
      now: () => 1000,
    });
    return m;
  }

  test("the first poll reports the baseline once, then only transitions", async () => {
    const m = monitor({ resource: [runningPod, runningPod, crashingPod, crashingPod, runningPod] });
    const first = await m.poll(watched);
    expect(first.map((a) => [a.level, a.title, a.body])).toEqual([["info", "Watching Pod billing/web", "Currently Running."]]);
    expect(await m.poll(watched)).toEqual([]);
    const broke = await m.poll(watched);
    expect(broke.map((a) => [a.level, a.title])).toEqual([["error", "Pod billing/web is CrashLoopBackOff"]]);
    expect(broke[0].body).toBe("app: back-off 40s");
    expect(await m.poll(watched)).toEqual([]);
    const back = await m.poll(watched);
    expect(back.map((a) => [a.level, a.title, a.body])).toEqual([["info", "Pod billing/web recovered", "Now Running."]]);
  });

  test("watching an already-broken object says so up front as a warning", async () => {
    const m = monitor({ resource: [crashingPod] });
    const first = await m.poll(watched);
    expect(first[0].level).toBe("warning");
    expect(first[0].body).toBe("Currently CrashLoopBackOff — app: back-off 40s.");
  });

  test("a different unhealthy reason is a warning, a read error is silence", async () => {
    const pull = res("Pod", { status: { phase: "Pending", containerStatuses: [{ name: "app", ready: false, restartCount: 0, state: { waiting: { reason: "ImagePullBackOff" } } }] } });
    const m = monitor({ resource: [crashingPod, new Error("timeout"), pull] });
    await m.poll(watched);
    expect(await m.poll(watched)).toEqual([]);
    const changed = await m.poll(watched);
    expect(changed.map((a) => [a.level, a.title])).toEqual([["warning", "Pod billing/web is ImagePullBackOff"]]);
  });

  test("disappearance and return are reported once each", async () => {
    const m = monitor({ resource: [runningPod, null, null, runningPod] });
    await m.poll(watched);
    expect((await m.poll(watched)).map((a) => a.title)).toEqual(["Pod billing/web is gone"]);
    expect(await m.poll(watched)).toEqual([]);
    expect((await m.poll(watched)).map((a) => a.title)).toEqual(["Pod billing/web is back"]);
  });

  test("existing events are swallowed at baseline; new Warning events alert, Normal ones do not", async () => {
    const old: K8sEvent = { type: "Warning", reason: "BackOff", message: "old", count: 3, last_timestamp: "t0" };
    const fresh: K8sEvent = { type: "Warning", reason: "Unhealthy", message: "probe failed", count: 1, last_timestamp: "t1" };
    const normal: K8sEvent = { type: "Normal", reason: "Pulled", message: "ok", count: 1, last_timestamp: "t1" };
    const repeat: K8sEvent = { ...old, count: 4, last_timestamp: "t2" };
    const m = monitor({ resource: [runningPod], events: [[old], [old, fresh, normal], [old, fresh, normal, repeat], [old, fresh, normal, repeat]] });
    await m.poll(watched);
    expect((await m.poll(watched)).map((a) => [a.title, a.body])).toEqual([["Pod billing/web: Unhealthy", "probe failed"]]);
    expect((await m.poll(watched)).map((a) => a.body)).toEqual(["old (×4)"]);
    expect(await m.poll(watched)).toEqual([]);
  });

  test("tick polls every watched resource; retain drops the rest", async () => {
    const m = monitor({ resource: [runningPod] });
    const other = { ...watched, id: "w2", name: "api" };
    const alerts = await m.tick([watched, other]);
    expect(alerts.map((a) => a.watchedId)).toEqual(["w1", "w2"]);
    m.retain([other]);
    // w1 was forgotten, so it baselines again.
    expect((await m.poll(watched))[0].title).toBe("Watching Pod billing/web");
    expect(await m.poll(other)).toEqual([]);
  });
});
