// Pure helpers for the Overview and Problems views.

import type { ClusterOverview, DiagnosisVerdict, NodeSummary, PodRef, Problem, ProblemCause, ProblemKind, ProblemSeverity } from "$lib/types";
import { parseWorkloadRef, type WorkloadRef } from "$lib/utils/pod-status";

export interface Tile {
  label: string;
  value: string;
  /** Secondary line under the value. */
  note: string;
  tone: "neutral" | "success" | "warning" | "error";
}

export function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/** Requests-to-allocatable pressure for one node, null when requests unknown. */
export function nodePressure(n: NodeSummary): { cpu: number | null; memory: number | null } {
  return {
    cpu: n.cpu_requests === null ? null : pct(n.cpu_requests, n.cpu_allocatable),
    memory: n.memory_requests === null ? null : pct(n.memory_requests, n.memory_allocatable),
  };
}

/** A node needs a look when it is NotReady, under pressure, cordoned, or >90% committed. */
export function nodeNeedsAttention(n: NodeSummary): boolean {
  const p = nodePressure(n);
  return !n.ready || n.pressure.length > 0 || n.unschedulable || (p.cpu ?? 0) > 90 || (p.memory ?? 0) > 90;
}

export function countBySeverity(problems: readonly Problem[]): Record<ProblemSeverity, number> {
  const c: Record<ProblemSeverity, number> = { critical: 0, warning: 0 };
  for (const p of problems) c[p.severity]++;
  return c;
}

export function countByKind(problems: readonly Problem[]): Partial<Record<ProblemKind, number>> {
  const c: Partial<Record<ProblemKind, number>> = {};
  for (const p of problems) c[p.kind] = (c[p.kind] ?? 0) + 1;
  return c;
}

export interface ProblemFilter {
  severity: ProblemSeverity | null;
  kind: ProblemKind | null;
  text: string;
}

export const EMPTY_PROBLEM_FILTER: ProblemFilter = { severity: null, kind: null, text: "" };

export function filterProblems(problems: readonly Problem[], f: ProblemFilter): Problem[] {
  const q = f.text.trim().toLowerCase();
  return problems.filter((p) => {
    if (f.severity && p.severity !== f.severity) return false;
    if (f.kind && p.kind !== f.kind) return false;
    if (!q) return true;
    return `${p.name} ${p.namespace ?? ""} ${p.reason} ${p.detail ?? ""} ${p.owner ?? ""}`.toLowerCase().includes(q);
  });
}

/** The four headline tiles on the Overview. */
export function overviewTiles(o: ClusterOverview): Tile[] {
  const readyNodes = o.nodes.filter((n) => n.ready).length;
  const pressure = o.nodes.filter((n) => n.pressure.length > 0).length;
  const sev = countBySeverity(o.problems);
  const p = o.pods;
  return [
    {
      label: "Nodes",
      value: `${readyNodes}/${o.nodes.length}`,
      note: o.nodes.length === 0 ? "not listable" : pressure > 0 ? `${pressure} under pressure` : readyNodes === o.nodes.length ? "all Ready" : `${o.nodes.length - readyNodes} NotReady`,
      tone: o.nodes.length === 0 ? "neutral" : readyNodes < o.nodes.length ? "error" : pressure > 0 ? "warning" : "success",
    },
    {
      label: "Pods",
      value: String(p.total),
      note: `${p.running} Running · ${p.pending} Pending · ${p.failed} Failed${p.succeeded ? ` · ${p.succeeded} Succeeded` : ""}`,
      // The tone colours the headline count, and "32" is not the thing that is
      // wrong — the note says what is. Failed or Pending pods therefore lift
      // the tile to warning, never to error: the Problems tile carries red.
      tone: p.failed > 0 || p.pending > 0 ? "warning" : "success",
    },
    {
      label: "Problems",
      value: String(o.problems.length),
      note: o.problems.length === 0 ? "nothing needs attention" : `${sev.critical} critical · ${sev.warning} warning`,
      tone: sev.critical > 0 ? "error" : sev.warning > 0 ? "warning" : "success",
    },
    {
      label: "Warnings · last hour",
      value: String(o.warnings_total),
      note: o.warnings_total === 0 ? "no Warning events" : topReasons(o.warnings.map((w) => w.reason), 3),
      tone: o.warnings_total === 0 ? "success" : "warning",
    },
  ];
}

/** "11 BackOff · 4 FailedScheduling · 2 Unhealthy" from a list of reasons. */
export function topReasons(reasons: readonly string[], limit: number): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([r, n]) => `${n} ${r}`)
    .join(" · ");
}

const RESTARTABLE: ReadonlySet<string> = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

/** The workload a problem's Restart action rolls: the workload itself, or a pod's owner. */
export function restartTargetFor(p: Problem): WorkloadRef | null {
  if (RESTARTABLE.has(p.kind)) return { kind: p.kind, name: p.name };
  if (p.kind !== "Pod") return null;
  const owner = parseWorkloadRef(p.owner);
  return owner && RESTARTABLE.has(owner.kind) ? owner : null;
}

/** Causes a rolling restart can plausibly fix. A missing secret or a bad image tag only comes back the same. */
const RESTART_CAUSES: ReadonlySet<ProblemCause> = new Set(["crash", "oom", "unknown"]);

export const CAUSE_LABEL: Record<ProblemCause, string> = {
  "image-pull": "Image cannot be pulled",
  config: "Configuration error",
  crash: "Crash loop",
  oom: "Out of memory",
  unschedulable: "Unschedulable",
  "progress-deadline": "Rollout stuck",
  "job-failed": "Job failed",
  "pvc-pending": "Volume not provisioned",
  "no-endpoints": "No endpoints",
  "lb-pending": "LoadBalancer pending",
  unknown: "",
};

export interface ProblemActions {
  /** The pod "Open pod" / "View pod logs" land on; null when the problem has none. */
  pod: PodRef | null;
  /** Offer the rolling restart — only when the cause is one a restart can fix. */
  restart: boolean;
  /** Offer "Open <kind> YAML" — the fix for image/config/scheduling/rollout problems is an edit. */
  yaml: boolean;
}

/**
 * Which actions the detail panel offers for a problem. The diagnosis, when it
 * has run, knows the owned pods better than the overview snapshot and wins.
 * A pod-kind problem points at itself. `cause` falls back to "unknown" for
 * payloads from an older backend so the panel never loses its buttons.
 */
export function problemActions(p: Problem, verdict?: Partial<DiagnosisVerdict> | null): ProblemActions {
  const cause: ProblemCause = verdict?.cause ?? p.cause ?? "unknown";
  const self: PodRef | null = p.kind === "Pod" && p.namespace ? { name: p.name, namespace: p.namespace, container: null } : null;
  const pod = verdict?.pod ?? p.pod ?? self;
  const restart = restartTargetFor(p) !== null && RESTART_CAUSES.has(cause);
  const yaml = p.kind !== "Node" && (cause === "image-pull" || cause === "config" || cause === "unschedulable" || cause === "progress-deadline" || cause === "oom" || cause === "pvc-pending" || cause === "no-endpoints" || cause === "lb-pending");
  return { pod, restart, yaml };
}
