// Saved port forwards: pure logic.
//
// A saved forward names a *target* (a Pod, or a workload / Service that owns
// pods) plus a port pair. Starting it resolves the target to one running pod
// and opens a session; when that session dies unexpectedly the keeper retries
// with a growing delay until the user stops it or the context changes. None of
// this touches Svelte or IPC — the store injects the resolver, the starter and
// the timers, so the behaviour is unit-tested here.

import type { ForwardTargetKind, PortForwardInfo, Resource, SavedPortForward } from "$lib/types";

// ---------------------------------------------------------------------------
// Saved-forward bookkeeping
// ---------------------------------------------------------------------------

export function savedForwardsFor(list: readonly SavedPortForward[], context: string): SavedPortForward[] {
  return list.filter((f) => f.context === context);
}

/** The saved forward an active session came from, if any. */
export function savedForSession(
  list: readonly SavedPortForward[],
  pf: Pick<PortForwardInfo, "saved_id">,
): SavedPortForward | undefined {
  return pf.saved_id ? list.find((f) => f.id === pf.saved_id) : undefined;
}

/**
 * A saved forward that would recreate `pf` for `target` — the same local and
 * remote ports in the same namespace and context. Not auto-started by default:
 * the user opts in per forward.
 */
export function savedFromActive(
  pf: Pick<PortForwardInfo, "namespace" | "container_port" | "local_port">,
  context: string,
  target: { kind: ForwardTargetKind; name: string },
  id: string,
): SavedPortForward {
  return {
    id,
    context,
    namespace: pf.namespace,
    target_kind: target.kind,
    target_name: target.name,
    container_port: pf.container_port,
    local_port: pf.local_port,
    auto_start: false,
  };
}

/** Two saved forwards that would open the same local port for the same target. */
export function sameForward(a: SavedPortForward, b: SavedPortForward): boolean {
  return (
    a.context === b.context &&
    a.namespace === b.namespace &&
    a.target_kind === b.target_kind &&
    a.target_name === b.target_name &&
    a.container_port === b.container_port &&
    a.local_port === b.local_port
  );
}

export function describeTarget(f: Pick<SavedPortForward, "target_kind" | "target_name">): string {
  const short: Record<ForwardTargetKind, string> = {
    Pod: "pod",
    Service: "svc",
    Deployment: "deploy",
    StatefulSet: "sts",
    DaemonSet: "ds",
  };
  return `${short[f.target_kind] ?? f.target_kind.toLowerCase()}/${f.target_name}`;
}

/**
 * The workload a pod belongs to, read off its owner references: StatefulSet
 * and DaemonSet own pods directly; a ReplicaSet is (almost always) a
 * Deployment's, and Deployment-owned ReplicaSets are named
 * `<deployment>-<pod-template-hash>`, so stripping the last segment gives the
 * Deployment. Falls back to the pod itself (a bare pod, a Job, an unknown
 * controller) — which still forwards, it just will not survive the pod.
 */
export function inferForwardTarget(pod: Pick<Resource, "metadata">): { kind: ForwardTargetKind; name: string } {
  for (const owner of pod.metadata.owner_references ?? []) {
    if (owner.kind === "StatefulSet" || owner.kind === "DaemonSet") {
      return { kind: owner.kind, name: owner.name };
    }
    if (owner.kind === "ReplicaSet") {
      const idx = owner.name.lastIndexOf("-");
      if (idx > 0) return { kind: "Deployment", name: owner.name.slice(0, idx) };
    }
  }
  return { kind: "Pod", name: pod.metadata.name };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export interface ResolveDeps {
  /** Full object by Kind + name + namespace (get_resource). Null when missing. */
  getResource: (kind: string, name: string, namespace: string) => Promise<Resource | null>;
  /** Pods matching a `k=v,k=v` selector (list_pods_by_selector). */
  listPodsBySelector: (namespace: string, selector: string) => Promise<Resource[]>;
}

export interface ResolvedForward {
  podName: string;
  containerPort: number;
}

type Json = Record<string, unknown>;

function selectorOf(obj: Resource): string {
  const spec = (obj.spec ?? {}) as Json;
  const raw =
    obj.kind === "Service"
      ? (spec.selector as Record<string, string> | undefined)
      : ((spec.selector as Json | undefined)?.matchLabels as Record<string, string> | undefined);
  return Object.entries(raw ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function podIsUsable(pod: Resource): boolean {
  if (pod.metadata.deletion_timestamp) return false;
  const status = (pod.status ?? {}) as Json;
  return status.phase === "Running";
}

function podIsReady(pod: Resource): boolean {
  const status = (pod.status ?? {}) as Json;
  const conds = (status.conditions as Array<{ type: string; status: string }> | undefined) ?? [];
  return conds.some((c) => c.type === "Ready" && c.status === "True");
}

/** Prefer a Ready pod; otherwise any Running one; otherwise null. */
export function pickPod(pods: readonly Resource[]): Resource | null {
  const usable = pods.filter(podIsUsable);
  return usable.find(podIsReady) ?? usable[0] ?? null;
}

/**
 * Map a Service port to the pod port it targets: `targetPort` may be a number
 * or a named container port; absent, it equals the service port.
 */
export function serviceTargetPort(service: Resource, servicePort: number, pod: Resource): number {
  const ports = ((service.spec as Json).ports as Array<{ port: number; targetPort?: number | string }> | undefined) ?? [];
  const entry = ports.find((p) => p.port === servicePort);
  const target = entry?.targetPort ?? servicePort;
  if (typeof target === "number") return target;
  const containers = ((pod.spec as Json).containers as Array<{ ports?: Array<{ name?: string; containerPort: number }> }> | undefined) ?? [];
  for (const c of containers) {
    const hit = c.ports?.find((p) => p.name === target);
    if (hit) return hit.containerPort;
  }
  throw new Error(`Service port ${servicePort} targets named port "${target}", which pod ${pod.metadata.name} does not expose`);
}

/** Resolve a saved forward to the pod and port a session should open. */
export async function resolveForward(saved: SavedPortForward, deps: ResolveDeps): Promise<ResolvedForward> {
  if (saved.target_kind === "Pod") {
    return { podName: saved.target_name, containerPort: saved.container_port };
  }
  const owner = await deps.getResource(saved.target_kind, saved.target_name, saved.namespace);
  if (!owner) {
    throw new Error(`${describeTarget(saved)} not found in namespace "${saved.namespace}"`);
  }
  const selector = selectorOf(owner);
  if (!selector) throw new Error(`${describeTarget(saved)} has no pod selector`);
  const pod = pickPod(await deps.listPodsBySelector(saved.namespace, selector));
  if (!pod) throw new Error(`No running pod behind ${describeTarget(saved)}`);
  const containerPort =
    saved.target_kind === "Service" ? serviceTargetPort(owner, saved.container_port, pod) : saved.container_port;
  return { podName: pod.metadata.name, containerPort };
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

/** Retry schedule after an unexpected close; the last delay repeats. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 3_000, 5_000, 10_000, 20_000];
export const MAX_RECONNECT_ATTEMPTS = 8;

export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
}

export type SavedForwardState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "active"; sessionId: string; podName: string }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "error"; message: string };

export interface KeeperDeps {
  /** Resolve + start a session; resolves to the session id and the pod it hit. */
  start: (saved: SavedPortForward) => Promise<{ sessionId: string; podName: string }>;
  /** Stop an active session (best effort). */
  stop: (sessionId: string) => Promise<void>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Called whenever a forward's state changes, so the store can re-render. */
  onState?: (id: string, state: SavedForwardState) => void;
}

/**
 * Owns the lifecycle of every started saved forward: start, stop, and the
 * retry loop after an unexpected close. One instance per app; the store feeds
 * it `sessionClosed` from the `port-forward-closed` channel.
 */
export class SavedForwardKeeper {
  readonly states = new Map<string, SavedForwardState>();
  private readonly timers = new Map<string, unknown>();
  /** Generation per forward — a stop or restart invalidates in-flight work. */
  private readonly gen = new Map<string, number>();

  constructor(private readonly deps: KeeperDeps) {}

  stateOf(id: string): SavedForwardState {
    return this.states.get(id) ?? { kind: "idle" };
  }

  private setState(id: string, state: SavedForwardState): void {
    if (state.kind === "idle") this.states.delete(id);
    else this.states.set(id, state);
    this.deps.onState?.(id, state);
  }

  private bump(id: string): number {
    const next = (this.gen.get(id) ?? 0) + 1;
    this.gen.set(id, next);
    return next;
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      this.deps.clearTimeout(t);
      this.timers.delete(id);
    }
  }

  /** Start (or restart) a saved forward. Resolves when the first attempt settles. */
  async start(saved: SavedPortForward): Promise<void> {
    const current = this.stateOf(saved.id);
    if (current.kind === "active" || current.kind === "starting") return;
    this.clearTimer(saved.id);
    const gen = this.bump(saved.id);
    await this.attempt(saved, gen, 0);
  }

  private async attempt(saved: SavedPortForward, gen: number, retry: number): Promise<void> {
    this.setState(saved.id, retry === 0 ? { kind: "starting" } : { kind: "reconnecting", attempt: retry });
    try {
      const { sessionId, podName } = await this.deps.start(saved);
      if (this.gen.get(saved.id) !== gen) {
        // Stopped while starting — do not leak the session.
        void this.deps.stop(sessionId);
        return;
      }
      this.setState(saved.id, { kind: "active", sessionId, podName });
    } catch (err) {
      if (this.gen.get(saved.id) !== gen) return;
      const message = err instanceof Error ? err.message : String(err);
      if (retry + 1 >= MAX_RECONNECT_ATTEMPTS) {
        this.setState(saved.id, { kind: "error", message });
        return;
      }
      this.scheduleRetry(saved, gen, retry + 1, message);
    }
  }

  private scheduleRetry(saved: SavedPortForward, gen: number, retry: number, lastError?: string): void {
    void lastError;
    this.setState(saved.id, { kind: "reconnecting", attempt: retry });
    const handle = this.deps.setTimeout(() => {
      this.timers.delete(saved.id);
      if (this.gen.get(saved.id) !== gen) return;
      void this.attempt(saved, gen, retry);
    }, reconnectDelay(retry - 1));
    this.timers.set(saved.id, handle);
  }

  /**
   * The backend reported a session gone. Returns the saved forward's id when
   * the session belonged to one (and a retry was scheduled), else null — so
   * the caller knows whether to tell the user "stopped" or "reconnecting".
   */
  sessionClosed(sessionId: string, saved: SavedPortForward | undefined): string | null {
    if (!saved) return null;
    const state = this.stateOf(saved.id);
    if (state.kind !== "active" || state.sessionId !== sessionId) return null;
    const gen = this.bump(saved.id);
    this.scheduleRetry(saved, gen, 1);
    return saved.id;
  }

  /** Take over a session started elsewhere (the user saved an active forward). */
  adopt(id: string, sessionId: string, podName: string): void {
    this.clearTimer(id);
    this.bump(id);
    this.setState(id, { kind: "active", sessionId, podName });
  }

  /** Forget a forward without touching its session (the user un-saved it). */
  release(id: string): void {
    this.bump(id);
    this.clearTimer(id);
    this.setState(id, { kind: "idle" });
  }

  /** User stop: cancel retries, close the session, back to idle. */
  async stop(id: string): Promise<void> {
    this.bump(id);
    this.clearTimer(id);
    const state = this.stateOf(id);
    this.setState(id, { kind: "idle" });
    if (state.kind === "active") await this.deps.stop(state.sessionId);
  }

  /** Context switch / shutdown: drop every forward without stopping sessions
   *  (the store already tore those down) and forget their state. */
  reset(): void {
    for (const id of [...this.states.keys(), ...this.timers.keys()]) {
      this.bump(id);
      this.clearTimer(id);
      this.setState(id, { kind: "idle" });
    }
  }
}
