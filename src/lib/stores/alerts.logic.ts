// Desktop alerts for watched resources — pure logic.
//
// The app's resource watch only covers the type on screen, so alerting polls:
// every tick the monitor re-reads each watched object and its events through
// injected fetchers, derives a health verdict, and reports transitions
// (healthy → unhealthy, back to healthy, gone) plus Warning events it has not
// seen before. No Svelte, no IPC, no timers — the store supplies those.

import type { Event as K8sEvent, Resource, WatchedResource } from "$lib/types";
import { podProblem, podStatus } from "$lib/utils/pod-status";
import { workloadStatus } from "$lib/utils/workload-status";

export interface Health {
  ok: boolean;
  /** Short label: "Running", "CrashLoopBackOff", "Available", "2/3 ready"… */
  label: string;
  detail?: string;
}

type Json = Record<string, unknown>;

/**
 * Is the object in a state worth waking someone up for? Transient states
 * (a rollout in progress, a Pending pod that is merely scheduling) are fine;
 * broken containers, failed rollouts, missing replicas and NotReady nodes are
 * not. Kinds without a notion of health are always ok — they still alert on
 * Warning events.
 */
export function healthOf(resource: Resource): Health {
  if (resource.kind === "Pod") {
    const problem = podProblem(resource);
    if (problem) {
      const where = problem.container ? `${problem.container}: ` : "";
      return { ok: false, label: problem.reason, detail: `${where}${problem.message ?? ""}`.trim() || undefined };
    }
    const phase = String(((resource.status ?? {}) as Json).phase ?? "");
    if (phase === "Failed" || phase === "Unknown") return { ok: false, label: phase };
    return { ok: true, label: podStatus(resource).label };
  }
  const st = workloadStatus(resource);
  if (!st) return { ok: true, label: "—" };
  return { ok: st.tone !== "bad", label: st.label, detail: st.detail };
}

export type AlertLevel = "warning" | "error" | "info";

/** What kind of thing happened — the store decides how loud to be from this, not from the title. */
export type AlertKind = "baseline" | "transition" | "event" | "presence";

export interface Alert {
  watchedId: string;
  kind: AlertKind;
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
        alerts.push({ watchedId: w.id, kind: "presence", level: "error", title: `${name} is gone`, body: "The watched object no longer exists.", at });
      }
      return alerts;
    }
    if (t.missing) {
      t.missing = false;
      alerts.push({ watchedId: w.id, kind: "presence", level: "info", title: `${name} is back`, body: "The watched object exists again.", at });
    }

    const health = healthOf(resource);
    if (first) {
      alerts.push({
        watchedId: w.id,
        kind: "baseline",
        level: health.ok ? "info" : "warning",
        title: `Watching ${name}`,
        body: health.ok ? `Currently ${health.label}.` : `Currently ${health.label}${health.detail ? ` — ${health.detail}` : ""}.`,
        at,
      });
    } else if (t.lastOk !== null && health.ok !== t.lastOk) {
      alerts.push(
        health.ok
          ? { watchedId: w.id, kind: "transition", level: "info", title: `${name} recovered`, body: `Now ${health.label}.`, at }
          : { watchedId: w.id, kind: "transition", level: "error", title: `${name} is ${health.label}`, body: health.detail ?? `Was ${t.lastLabel}.`, at },
      );
    } else if (!health.ok && health.label !== t.lastLabel) {
      // Still unhealthy, differently: CrashLoopBackOff → ImagePullBackOff.
      alerts.push({ watchedId: w.id, kind: "transition", level: "warning", title: `${name} is ${health.label}`, body: health.detail ?? `Was ${t.lastLabel}.`, at });
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
        kind: "event",
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
