// Pure helpers for the Rightsizing panel: quantities, the SSA patch, filters.

import type { ContainerRightsizing, RightsizingVerdict, WorkloadRightsizing } from "$lib/types";

const MI = 1024 * 1024;

/** Kubernetes quantity string for a CPU request: millicores under 1, cores above. */
export function cpuQuantity(cores: number): string {
  const m = Math.round(cores * 1000);
  return m < 1000 || m % 1000 !== 0 ? `${m}m` : `${m / 1000}`;
}

/** Kubernetes quantity string for memory, in Mi (or Gi when whole). */
export function memoryQuantity(bytes: number): string {
  const mi = Math.round(bytes / MI);
  return mi >= 1024 && mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

export function formatSaving(usd: number): string {
  const abs = Math.abs(usd);
  const s = abs < 0.5 ? "<$1" : `$${Math.round(abs)}`;
  return usd < 0 ? `−${s}` : s;
}

/** apiVersion for the workload kinds a patch can target. */
export function apiVersionFor(kind: string): string | null {
  switch (kind) {
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
      return "apps/v1";
    default:
      return null;
  }
}

/** Containers that have something to change, with the new requests. */
export function changedContainers(w: WorkloadRightsizing): Array<{ name: string; cpu: string | null; memory: string | null }> {
  const out: Array<{ name: string; cpu: string | null; memory: string | null }> = [];
  for (const c of w.containers) {
    const cpu = (c.cpu_verdict === "over" || c.cpu_verdict === "under" || c.cpu_verdict === "no-request") && c.cpu_recommended !== null ? cpuQuantity(c.cpu_recommended) : null;
    const memory = (c.memory_verdict === "over" || c.memory_verdict === "under" || c.memory_verdict === "no-request") && c.memory_recommended !== null ? memoryQuantity(c.memory_recommended) : null;
    if (cpu || memory) out.push({ name: c.container, cpu, memory });
  }
  return out;
}

/**
 * A server-side-apply manifest that only sets the recommended requests on the
 * containers that need them — SSA merges containers by name, so nothing else
 * in the pod template is touched. Null when the kind cannot be patched
 * (bare pods, jobs) or nothing would change.
 */
export function rightsizingPatchYaml(w: WorkloadRightsizing): string | null {
  const apiVersion = apiVersionFor(w.kind);
  const changes = changedContainers(w);
  if (!apiVersion || changes.length === 0) return null;
  const lines = [
    `apiVersion: ${apiVersion}`,
    `kind: ${w.kind}`,
    "metadata:",
    `  name: ${w.name}`,
    `  namespace: ${w.namespace}`,
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
  ];
  for (const c of changes) {
    lines.push(`        - name: ${c.name}`, "          resources:", "            requests:");
    if (c.cpu) lines.push(`              cpu: ${c.cpu}`);
    if (c.memory) lines.push(`              memory: ${c.memory}`);
  }
  return lines.join("\n") + "\n";
}

export type RightsizingFilter = "all" | "over" | "under" | "ok";

export function filterWorkloads(ws: readonly WorkloadRightsizing[], f: RightsizingFilter, text: string): WorkloadRightsizing[] {
  const q = text.trim().toLowerCase();
  return ws.filter((w) => {
    if (f === "over" && w.verdict !== "over") return false;
    if (f === "under" && w.verdict !== "under") return false;
    if (f === "ok" && w.verdict !== "ok") return false;
    if (!q) return true;
    return `${w.kind} ${w.name} ${w.namespace}`.toLowerCase().includes(q);
  });
}

export function verdictLabel(v: RightsizingVerdict): string {
  switch (v) {
    case "over": return "over-provisioned";
    case "under": return "under-provisioned";
    case "ok": return "right-sized";
    case "no-request": return "no request";
    default: return "no data";
  }
}

/** Share of the request actually used, for the usage bar (null without data). */
export function usageShare(c: ContainerRightsizing, which: "cpu" | "memory"): number | null {
  const req = which === "cpu" ? c.cpu_request : c.memory_request;
  const use = which === "cpu" ? c.cpu_usage : c.memory_usage;
  if (req === null || req === 0 || use === null) return null;
  return Math.min(150, Math.round((use / req) * 100));
}
