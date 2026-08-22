// Pure helpers for the Overview and Problems views.

import type { ClusterOverview, NodeSummary, Problem, ProblemKind, ProblemSeverity } from "$lib/types";

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
      tone: p.failed > 0 ? "error" : p.pending > 0 ? "warning" : "success",
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

/** The resource_type a problem's detail tab opens on. */
export function problemResourceType(kind: ProblemKind): string {
  const map: Record<ProblemKind, string> = {
    Pod: "pods",
    Deployment: "deployments",
    StatefulSet: "statefulsets",
    DaemonSet: "daemonsets",
    Job: "jobs",
    Node: "nodes",
  };
  return map[kind];
}
