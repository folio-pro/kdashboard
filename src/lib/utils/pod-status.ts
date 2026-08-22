// The pod as kubectl reads it: one status word, a ready fraction, restarts
// with when the last one happened, the controller that owns it, and — when
// something is wrong — which container and why.
//
// `status.phase` alone is not a status: a pod whose container is in
// CrashLoopBackOff still has phase Running. These helpers walk the container
// statuses the way `kubectl get pods` does (printers.go / printPod), so the
// table and the detail panel agree with what an operator sees in a terminal.
// Pure: runs under bun with no Svelte runtime.

import type { Resource } from "$lib/types";

type Json = Record<string, unknown>;

interface ContainerState {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; message?: string; exitCode?: number; signal?: number; finishedAt?: string; startedAt?: string };
}

export interface ContainerStatusLike {
  name?: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  image?: string;
  state?: ContainerState;
  lastState?: ContainerState;
}

export interface PodCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/** The one word a row shows, plus the short "why" a Pending pod carries. */
export interface PodStatusInfo {
  label: string;
  /** Why the pod is where it is, when the label alone does not say ("Unschedulable"). */
  reason?: string;
}

function statuses(resource: Resource, key: "containerStatuses" | "initContainerStatuses"): ContainerStatusLike[] {
  const list = (resource.status as Json | undefined)?.[key];
  return Array.isArray(list) ? (list as ContainerStatusLike[]) : [];
}

export function podConditions(resource: Resource): PodCondition[] {
  const list = (resource.status as Json | undefined)?.conditions;
  return Array.isArray(list) ? (list as PodCondition[]).filter((c) => c && typeof c.type === "string") : [];
}

function condition(resource: Resource, type: string): PodCondition | undefined {
  return podConditions(resource).find((c) => c.type === type);
}

/** "ExitCode:137" / "Signal:9" — what kubectl prints for an unexplained termination. */
function terminationLabel(t: NonNullable<ContainerState["terminated"]>): string {
  if (t.signal !== undefined && t.signal !== 0) return `Signal:${t.signal}`;
  return `ExitCode:${t.exitCode ?? 0}`;
}

/**
 * The kubectl STATUS column for a pod. Init containers first (`Init:1/2`,
 * `Init:CrashLoopBackOff`), then the app containers' waiting / terminated
 * reasons, then the phase; a pod being deleted reads Terminating regardless.
 */
export function podStatus(resource: Resource): PodStatusInfo {
  const status = (resource.status ?? {}) as Json;
  const phase = typeof status.phase === "string" ? status.phase : "Unknown";
  let reason = typeof status.reason === "string" && status.reason ? status.reason : phase;

  const init = statuses(resource, "initContainerStatuses");
  let initializing = false;
  for (let i = 0; i < init.length; i++) {
    const cs = init[i];
    const t = cs.state?.terminated;
    const w = cs.state?.waiting;
    if (t && (t.exitCode ?? 0) === 0) continue;
    if (t) {
      reason = t.reason ? `Init:${t.reason}` : `Init:${terminationLabel(t)}`;
      initializing = true;
      break;
    }
    // A sidecar (restartable init container) that has started is done.
    if (cs.state?.running && cs.started) continue;
    if (w?.reason && w.reason !== "PodInitializing") {
      reason = `Init:${w.reason}`;
    } else {
      reason = `Init:${i}/${init.length}`;
    }
    initializing = true;
    break;
  }

  if (!initializing) {
    let hasRunning = false;
    const cs = statuses(resource, "containerStatuses");
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      const w = c.state?.waiting;
      const t = c.state?.terminated;
      if (w?.reason) {
        reason = w.reason;
      } else if (t?.reason) {
        reason = t.reason;
      } else if (t) {
        reason = terminationLabel(t);
      } else if (c.ready && c.state?.running) {
        hasRunning = true;
      }
    }
    // Every container finished but the pod is still Running: the kubelet has
    // not caught up, or a sidecar is still up. kubectl reports Running / NotReady.
    if (reason === "Completed" && hasRunning) {
      reason = condition(resource, "Ready")?.status === "True" ? "Running" : "NotReady";
    }
  }

  const deleting = Boolean(resource.metadata?.deletion_timestamp);
  if (deleting && status.reason === "NodeLost") reason = "Unknown";
  else if (deleting) reason = "Terminating";

  const info: PodStatusInfo = { label: reason };
  if (reason === "Pending") {
    const scheduled = condition(resource, "PodScheduled");
    if (scheduled && scheduled.status !== "True" && scheduled.reason) info.reason = scheduled.reason;
  }
  return info;
}

/** Ready containers over the total, as the table's Ready column and kubectl show it. */
export function podReadyCount(resource: Resource): { ready: number; total: number } {
  const cs = statuses(resource, "containerStatuses");
  if (cs.length === 0) {
    // No statuses yet (Pending, or a lean row): fall back to the spec count.
    const spec = (resource.spec as Json | undefined)?.containers;
    return { ready: 0, total: Array.isArray(spec) ? spec.length : 0 };
  }
  return { ready: cs.filter((c) => c.ready).length, total: cs.length };
}

/** Total restarts across containers, and when the most recent one happened. */
export function podRestarts(resource: Resource): { count: number; lastAt: string | null } {
  let count = 0;
  let lastAt: string | null = null;
  for (const c of [...statuses(resource, "initContainerStatuses"), ...statuses(resource, "containerStatuses")]) {
    count += c.restartCount ?? 0;
    const finished = c.lastState?.terminated?.finishedAt;
    if (typeof finished === "string" && finished && (!lastAt || finished > lastAt)) lastAt = finished;
  }
  return { count, lastAt };
}

const OWNER_SHORT: Record<string, string> = {
  ReplicaSet: "rs",
  StatefulSet: "sts",
  DaemonSet: "ds",
  Job: "job",
  CronJob: "cj",
  Node: "node",
  ReplicationController: "rc",
  Deployment: "deploy",
};

export interface PodOwner {
  kind: string;
  name: string;
  /** kubectl-style short kind for the cell ("rs", "sts", "job"). */
  short: string;
}

/** The controller that owns the pod (the owner reference flagged `controller`, else the first). */
export function podOwner(resource: Resource): PodOwner | null {
  const refs = resource.metadata?.owner_references ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  if (!ref?.kind || !ref.name) return null;
  return { kind: ref.kind, name: ref.name, short: OWNER_SHORT[ref.kind] ?? ref.kind.toLowerCase() };
}

/** Which container state reasons mean "this is broken", as opposed to "still coming up". */
const BROKEN_REASON = /error|crash|backoff|oom|invalid|cannotrun|deadline|killed/i;

export interface PodProblem {
  /** The container at fault; undefined when the pod itself cannot start (Unschedulable). */
  container?: string;
  /** Whether it is an init container. */
  init?: boolean;
  reason: string;
  message?: string;
  /** Exit code of the last termination (current or previous state). */
  exitCode?: number;
  /** Reason of the last termination, when the container is now waiting (CrashLoopBackOff → Error). */
  lastReason?: string;
  /** When the last termination finished. */
  lastFinishedAt?: string;
  restartCount: number;
}

/**
 * The first thing wrong with the pod, for the detail panel's attention block:
 * an init container that failed, an app container waiting on an error or
 * terminated non-zero, or a Pending pod the scheduler cannot place. Null when
 * nothing is wrong (or the pod finished on purpose).
 */
export function podProblem(resource: Resource): PodProblem | null {
  const fromContainer = (c: ContainerStatusLike, init: boolean): PodProblem | null => {
    const w = c.state?.waiting;
    const t = c.state?.terminated;
    const last = c.lastState?.terminated;
    if (w?.reason && BROKEN_REASON.test(w.reason)) {
      return {
        container: c.name,
        init,
        reason: w.reason,
        message: w.message,
        exitCode: last?.exitCode,
        lastReason: last?.reason,
        lastFinishedAt: last?.finishedAt,
        restartCount: c.restartCount ?? 0,
      };
    }
    if (t && (t.exitCode ?? 0) !== 0) {
      return {
        container: c.name,
        init,
        reason: t.reason ?? terminationLabel(t),
        message: t.message,
        exitCode: t.exitCode,
        lastFinishedAt: t.finishedAt,
        restartCount: c.restartCount ?? 0,
      };
    }
    return null;
  };
  for (const c of statuses(resource, "initContainerStatuses")) {
    const p = fromContainer(c, true);
    if (p) return p;
  }
  for (const c of statuses(resource, "containerStatuses")) {
    const p = fromContainer(c, false);
    if (p) return p;
  }
  const scheduled = condition(resource, "PodScheduled");
  if (scheduled && scheduled.status !== "True" && scheduled.reason) {
    return { reason: scheduled.reason, message: scheduled.message, restartCount: 0 };
  }
  return null;
}

/** The order the four standard conditions are worth reading in. */
const CONDITION_ORDER = ["PodScheduled", "PodReadyToStartContainers", "Initialized", "ContainersReady", "Ready"];

/** Pod conditions in lifecycle order, unknown ones after. */
export function orderedPodConditions(resource: Resource): PodCondition[] {
  const rank = (t: string) => {
    const i = CONDITION_ORDER.indexOf(t);
    return i === -1 ? CONDITION_ORDER.length : i;
  };
  return [...podConditions(resource)].sort((a, b) => rank(a.type) - rank(b.type));
}
