import { describe, expect, test } from "bun:test";
import type { Resource, SavedPortForward } from "$lib/types";
import {
  SavedForwardKeeper,
  describeTarget,
  inferForwardTarget,
  pickPod,
  reconnectDelay,
  resolveForward,
  sameForward,
  savedForSession,
  savedForwardsFor,
  savedFromActive,
  serviceTargetPort,
  MAX_RECONNECT_ATTEMPTS,
  type SavedForwardState,
} from "./port-forwards.logic";

function res(kind: string, name: string, extra: Partial<Resource> = {}): Resource {
  return {
    kind,
    api_version: "v1",
    metadata: {
      name,
      namespace: "billing",
      uid: `${kind}-${name}`,
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
      ...(extra.metadata ?? {}),
    },
    spec: extra.spec ?? {},
    status: extra.status ?? {},
  };
}

const pod = (name: string, phase = "Running", ready = true, deleting = false): Resource =>
  res("Pod", name, {
    metadata: { name, deletion_timestamp: deleting ? "2026-01-01T00:00:00Z" : undefined } as Resource["metadata"],
    status: { phase, conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
    spec: { containers: [{ name: "web", ports: [{ name: "http", containerPort: 8080 }] }] },
  });

const saved = (over: Partial<SavedPortForward> = {}): SavedPortForward => ({
  id: "f1",
  context: "prod",
  namespace: "billing",
  target_kind: "Deployment",
  target_name: "payments-api",
  container_port: 8080,
  local_port: 18080,
  auto_start: false,
  ...over,
});

describe("bookkeeping", () => {
  test("savedForwardsFor filters by context; savedForSession finds by saved_id", () => {
    const list = [saved(), saved({ id: "f2", context: "dev" })];
    expect(savedForwardsFor(list, "prod").map((f) => f.id)).toEqual(["f1"]);
    expect(savedForSession(list, { saved_id: "f2" })?.context).toBe("dev");
    expect(savedForSession(list, {})).toBeUndefined();
  });

  test("savedFromActive keeps ports and namespace, not auto-started", () => {
    const s = savedFromActive(
      { namespace: "billing", container_port: 8080, local_port: 18080 },
      "prod",
      { kind: "Service", name: "payments-api" },
      "id-1",
    );
    expect(s).toEqual(saved({ id: "id-1", target_kind: "Service" }));
    expect(sameForward(s, saved({ target_kind: "Service" }))).toBe(true);
    expect(sameForward(s, saved({ target_kind: "Service", local_port: 1 }))).toBe(false);
  });

  test("describeTarget uses kubectl short names", () => {
    expect(describeTarget(saved())).toBe("deploy/payments-api");
    expect(describeTarget(saved({ target_kind: "Service" }))).toBe("svc/payments-api");
  });

  test("inferForwardTarget walks owner references", () => {
    const owned = (kind: string, name: string) =>
      res("Pod", "p", { metadata: { owner_references: [{ kind, name, api_version: "apps/v1", uid: "u" }] } as Resource["metadata"] });
    expect(inferForwardTarget(owned("ReplicaSet", "payments-api-7f9c8d"))).toEqual({ kind: "Deployment", name: "payments-api" });
    expect(inferForwardTarget(owned("StatefulSet", "kafka"))).toEqual({ kind: "StatefulSet", name: "kafka" });
    expect(inferForwardTarget(owned("DaemonSet", "fluent-bit"))).toEqual({ kind: "DaemonSet", name: "fluent-bit" });
    expect(inferForwardTarget(owned("Job", "export-123"))).toEqual({ kind: "Pod", name: "p" });
    expect(inferForwardTarget(res("Pod", "bare"))).toEqual({ kind: "Pod", name: "bare" });
  });
});

describe("resolution", () => {
  test("pickPod prefers Ready, then Running, never terminating", () => {
    expect(pickPod([pod("a", "Running", false), pod("b", "Running", true)])?.metadata.name).toBe("b");
    expect(pickPod([pod("a", "Pending"), pod("c", "Running", false)])?.metadata.name).toBe("c");
    expect(pickPod([pod("a", "Running", true, true)])).toBeNull();
  });

  test("serviceTargetPort maps numeric, named and implicit targetPorts", () => {
    const p = pod("x");
    const svc = (ports: unknown[]) => res("Service", "s", { spec: { ports } });
    expect(serviceTargetPort(svc([{ port: 80, targetPort: 8080 }]), 80, p)).toBe(8080);
    expect(serviceTargetPort(svc([{ port: 80, targetPort: "http" }]), 80, p)).toBe(8080);
    expect(serviceTargetPort(svc([{ port: 8080 }]), 8080, p)).toBe(8080);
    expect(() => serviceTargetPort(svc([{ port: 80, targetPort: "grpc" }]), 80, p)).toThrow(/grpc/);
  });

  test("a Pod target resolves to itself without any lookup", async () => {
    const r = await resolveForward(saved({ target_kind: "Pod", target_name: "p-1" }), {
      getResource: async () => { throw new Error("should not be called"); },
      listPodsBySelector: async () => { throw new Error("should not be called"); },
    });
    expect(r).toEqual({ podName: "p-1", containerPort: 8080 });
  });

  test("a Deployment target resolves through its selector to a running pod", async () => {
    const calls: string[] = [];
    const r = await resolveForward(saved(), {
      getResource: async (kind, name) => {
        calls.push(`get ${kind}/${name}`);
        return res("Deployment", name, { spec: { selector: { matchLabels: { app: "payments", tier: "api" } } } });
      },
      listPodsBySelector: async (_ns, selector) => {
        calls.push(`list ${selector}`);
        return [pod("old", "Running", true, true), pod("new")];
      },
    });
    expect(r).toEqual({ podName: "new", containerPort: 8080 });
    expect(calls).toEqual(["get Deployment/payments-api", "list app=payments,tier=api"]);
  });

  test("a Service target maps the service port to the pod port", async () => {
    const r = await resolveForward(saved({ target_kind: "Service", container_port: 80 }), {
      getResource: async () => res("Service", "s", { spec: { selector: { app: "web" }, ports: [{ port: 80, targetPort: "http" }] } }),
      listPodsBySelector: async () => [pod("w-1")],
    });
    expect(r).toEqual({ podName: "w-1", containerPort: 8080 });
  });

  test("missing owner / no selector / no pods each fail with a sentence", async () => {
    const base = { listPodsBySelector: async () => [] as Resource[] };
    await expect(resolveForward(saved(), { ...base, getResource: async () => null })).rejects.toThrow(/not found/);
    await expect(
      resolveForward(saved(), { ...base, getResource: async () => res("Deployment", "d") }),
    ).rejects.toThrow(/no pod selector/);
    await expect(
      resolveForward(saved(), {
        ...base,
        getResource: async () => res("Deployment", "d", { spec: { selector: { matchLabels: { a: "b" } } } }),
      }),
    ).rejects.toThrow(/No running pod/);
  });
});

describe("SavedForwardKeeper", () => {
  function harness(startImpl?: (s: SavedPortForward) => Promise<{ sessionId: string; podName: string }>) {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextTimer = 1;
    const stopped: string[] = [];
    const states: Array<[string, SavedForwardState]> = [];
    let attempts = 0;
    const keeper = new SavedForwardKeeper({
      start: startImpl ?? (async () => ({ sessionId: `s${++attempts}`, podName: `pod-${attempts}` })),
      stop: async (id) => { stopped.push(id); },
      setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ fn, ms, id }); return id; },
      clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
      onState: (id, st) => states.push([id, st]),
    });
    const fire = async () => { const t = timers.shift(); if (t) { t.fn(); await Promise.resolve(); await Promise.resolve(); } };
    return { keeper, timers, stopped, states, fire, attempts: () => attempts };
  }

  test("start goes starting → active and is idempotent while active", async () => {
    const h = harness();
    await h.keeper.start(saved());
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "active", sessionId: "s1", podName: "pod-1" });
    await h.keeper.start(saved());
    expect(h.attempts()).toBe(1);
    expect(h.states.map(([, s]) => s.kind)).toEqual(["starting", "active"]);
  });

  test("an unexpected close schedules a retry with the backoff schedule and re-activates", async () => {
    const h = harness();
    await h.keeper.start(saved());
    expect(h.keeper.sessionClosed("s1", saved())).toBe("f1");
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "reconnecting", attempt: 1 });
    expect(h.timers[0].ms).toBe(reconnectDelay(0));
    await h.fire();
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "active", sessionId: "s2", podName: "pod-2" });
  });

  test("a close for an unknown or stale session is ignored", async () => {
    const h = harness();
    expect(h.keeper.sessionClosed("nope", saved())).toBeNull();
    expect(h.keeper.sessionClosed("nope", undefined)).toBeNull();
    await h.keeper.start(saved());
    expect(h.keeper.sessionClosed("other-session", saved())).toBeNull();
    expect(h.keeper.stateOf("f1").kind).toBe("active");
  });

  test("failed attempts back off and give up after MAX_RECONNECT_ATTEMPTS", async () => {
    const h = harness(async () => { throw new Error("no pod"); });
    await h.keeper.start(saved());
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "reconnecting", attempt: 1 });
    const delays: number[] = [];
    for (let i = 1; i < MAX_RECONNECT_ATTEMPTS; i++) {
      delays.push(h.timers[0].ms);
      await h.fire();
    }
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "error", message: "no pod" });
    expect(h.timers).toHaveLength(0);
    expect(delays).toEqual([1000, 3000, 5000, 10000, 20000, 20000, 20000]);
  });

  test("stop cancels a pending retry and closes an active session", async () => {
    const h = harness();
    await h.keeper.start(saved());
    h.keeper.sessionClosed("s1", saved());
    await h.keeper.stop("f1");
    expect(h.timers).toHaveLength(0);
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "idle" });

    await h.keeper.start(saved());
    await h.keeper.stop("f1");
    expect(h.stopped).toEqual(["s2"]);
  });

  test("a session that lands after stop is closed rather than leaked", async () => {
    let release: (v: { sessionId: string; podName: string }) => void = () => {};
    const h = harness(() => new Promise((r) => { release = r; }));
    const starting = h.keeper.start(saved());
    await h.keeper.stop("f1");
    release({ sessionId: "late", podName: "p" });
    await starting;
    expect(h.stopped).toEqual(["late"]);
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "idle" });
  });

  test("reset forgets every forward and cancels timers without stopping sessions", async () => {
    const h = harness();
    await h.keeper.start(saved());
    await h.keeper.start(saved({ id: "f2" }));
    h.keeper.sessionClosed("s2", saved({ id: "f2" }));
    h.keeper.reset();
    expect(h.keeper.stateOf("f1")).toEqual({ kind: "idle" });
    expect(h.keeper.stateOf("f2")).toEqual({ kind: "idle" });
    expect(h.timers).toHaveLength(0);
    expect(h.stopped).toEqual([]);
  });
});
