// Desktop alerts for watched resources — pure logic.
//
// The app's resource watch only covers the type on screen, so alerting polls:
// every tick the monitor re-reads each watched object and its events through
// injected fetchers, derives a health verdict, and reports transitions
// (healthy → unhealthy, back to healthy, gone) plus Warning events it has not
// seen before. No Svelte, no IPC, no timers — the store supplies those.

import type { Event as K8sEvent, Resource, WatchedResource } from "$lib/types";
import { podProblem, podStatus } from "$lib/utils/pod-status";
import { deploymentStatus } from "$lib/utils/workload-status";

export interface Health {
  ok: boolean;
  /** Short label: "Running", "CrashLoopBackOff", "Available", "2/3 ready"… */
  label: string;
  detail?: string;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Is the object in a state worth waking someone up for? Transient states
 * (a rollout in progress, a Pending pod that is merely scheduling) are fine;
 * broken containers, failed rollouts, missing replicas and NotReady nodes are
 * not. Kinds without a notion of health are always ok — they still alert on
 * Warning events.
 */
export function healthOf(resource: Resource): Health {
  const status = (resource.status ?? {}) as Json;
  const spec = (resource.spec ?? {}) as Json;
  switch (resource.kind) {
    case "Pod": {
      const problem = podProblem(resource);
      if (problem) {
        const where = problem.container ? `${problem.container}: ` : "";
        return { ok: false, label: problem.reason, detail: `${where}${problem.message ?? ""}`.trim() || undefined };
      }
      const phase = String(status.phase ?? "");
      if (phase === "Failed" || phase === "Unknown") return { ok: false, label: phase };
      return { ok: true, label: podStatus(resource).label };
    }
    case "Deployment": {
      const st = deploymentStatus(resource);
      const bad = st.label === "Failed" || st.label === "Unavailable" || st.label === "ReplicaFailure";
      return { ok: !bad, label: st.label, detail: st.detail };
    }
    case "StatefulSet": {
      const desired = spec.replicas === undefined ? 1 : num(spec.replicas);
      const ready = num(status.readyReplicas);
      return { ok: desired === 0 || ready >= desired, label: `${ready}/${desired} ready` };
    }
    case "DaemonSet": {
      const desired = num(status.desiredNumberScheduled);
      const ready = num(status.numberReady);
      return { ok: desired === 0 || ready >= desired, label: `${ready}/${desired} ready` };
    }
    case "Job": {
      const conds = (status.conditions as Array<{ type: string; status: string; reason?: string }> | undefined) ?? [];
      const failed = conds.find((c) => c.type === "Failed" && c.status === "True");
      if (failed || num(status.failed) > 0) return { ok: false, label: "Failed", detail: failed?.reason };
      if (conds.some((c) => c.type === "Complete" && c.status === "True")) return { ok: true, label: "Complete" };
      return { ok: true, label: num(status.active) > 0 ? "Running" : "Pending" };
    }
    case "Node": {
      const conds = (status.conditions as Array<{ type: string; status: string; reason?: string }> | undefined) ?? [];
      const ready = conds.find((c) => c.type === "Ready");
      if (!ready || ready.status !== "True") return { ok: false, label: "NotReady", detail: ready?.reason };
      const pressure = conds.find((c) => c.type.endsWith("Pressure") && c.status === "True");
      if (pressure) return { ok: false, label: pressure.type, detail: pressure.reason };
      return { ok: true, label: "Ready" };
    }
    default:
      return { ok: true, label: "—" };
  }
}

export type AlertLevel = "warning" | "error" | "info";

export interface Alert {
  watchedId: string;
  level: AlertLevel;
  title: string;
  body: string;
  at: number;
}

export interface MonitorDeps {
  getResource: (w: WatchedResource) => Promise<Resource | null>;
  getEvents: (w: WatchedResource) => Promise<K8sEvent[]>;
  now?: () => number;
}

interface Tracked {
  lastOk: boolean | null;
  lastLabel: string;
  /** Event fingerprints already reported (or present when watching began). */
  seenEvents: Set<string>;
  missing: boolean;
}

/** Fingerprint of an event occurrence — a repeat bumps count/lastTimestamp. */
export function eventKey(e: K8sEvent): string {
  return `${e.reason}|${e.message}|${e.count ?? 1}|${e.last_timestamp ?? e.first_timestamp ?? ""}`;
}

export function describeWatched(w: Pick<WatchedResource, "kind" | "name" | "namespace">): string {
  return `${w.kind} ${w.namespace ? `${w.namespace}/` : ""}${w.name}`;
}

/**
 * Tracks health per watched resource across polls and turns changes into
 * alerts. The first poll of a resource is a baseline: it reports the current
 * state once ("now watching… currently CrashLoopBackOff") and swallows the
 * events that already exist, so watching a noisy object does not replay its
 * history.
 */
export class AlertMonitor {
  private readonly tracked = new Map<string, Tracked>();
  private readonly now: () => number;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  forget(id: string): void {
    this.tracked.delete(id);
  }

  /** Drop every resource not in `keep` (settings changed / context switched). */
  retain(keep: readonly WatchedResource[]): void {
    const ids = new Set(keep.map((w) => w.id));
    for (const id of [...this.tracked.keys()]) if (!ids.has(id)) this.tracked.delete(id);
  }

  /** Poll one resource; resolves to the alerts it produced (often none). */
  async poll(w: WatchedResource): Promise<Alert[]> {
    const alerts: Alert[] = [];
    const first = !this.tracked.has(w.id);
    const t: Tracked = this.tracked.get(w.id) ?? { lastOk: null, lastLabel: "", seenEvents: new Set(), missing: false };
    this.tracked.set(w.id, t);
    const name = describeWatched(w);
    const at = this.now();

    let resource: Resource | null;
    try {
      resource = await this.deps.getResource(w);
    } catch (err) {
      // A transient read failure is not an alert; the next tick retries.
      void err;
      return alerts;
    }

    if (!resource) {
      if (!t.missing) {
        t.missing = true;
        alerts.push({ watchedId: w.id, level: "error", title: `${name} is gone`, body: "The watched object no longer exists.", at });
      }
      return alerts;
    }
    if (t.missing) {
      t.missing = false;
      alerts.push({ watchedId: w.id, level: "info", title: `${name} is back`, body: "The watched object exists again.", at });
    }

    const health = healthOf(resource);
    if (first) {
      alerts.push({
        watchedId: w.id,
        level: health.ok ? "info" : "warning",
        title: `Watching ${name}`,
        body: health.ok ? `Currently ${health.label}.` : `Currently ${health.label}${health.detail ? ` — ${health.detail}` : ""}.`,
        at,
      });
    } else if (t.lastOk !== null && health.ok !== t.lastOk) {
      alerts.push(
        health.ok
          ? { watchedId: w.id, level: "info", title: `${name} recovered`, body: `Now ${health.label}.`, at }
          : { watchedId: w.id, level: "error", title: `${name} is ${health.label}`, body: health.detail ?? `Was ${t.lastLabel}.`, at },
      );
    } else if (!health.ok && health.label !== t.lastLabel) {
      // Still unhealthy, differently: CrashLoopBackOff → ImagePullBackOff.
      alerts.push({ watchedId: w.id, level: "warning", title: `${name} is ${health.label}`, body: health.detail ?? `Was ${t.lastLabel}.`, at });
    }
    t.lastOk = health.ok;
    t.lastLabel = health.label;

    let events: K8sEvent[] = [];
    try {
      events = await this.deps.getEvents(w);
    } catch {
      events = [];
    }
    for (const e of events) {
      const key = eventKey(e);
      if (t.seenEvents.has(key)) continue;
      t.seenEvents.add(key);
      if (first || e.type !== "Warning") continue;
      alerts.push({
        watchedId: w.id,
        level: "warning",
        title: `${name}: ${e.reason}`,
        body: `${e.message}${e.count && e.count > 1 ? ` (×${e.count})` : ""}`,
        at,
      });
    }
    // Cap the memory a chatty object can take.
    if (t.seenEvents.size > 500) {
      const keep = [...t.seenEvents].slice(-250);
      t.seenEvents.clear();
      for (const k of keep) t.seenEvents.add(k);
    }
    return alerts;
  }

  /** Poll every watched resource; alerts across all of them, in order. */
  async tick(watched: readonly WatchedResource[]): Promise<Alert[]> {
    const results = await Promise.all(watched.map((w) => this.poll(w)));
    return results.flat();
  }
}
