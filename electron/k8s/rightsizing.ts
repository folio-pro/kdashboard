// Rightsizing — pure logic: requests vs observed usage per container of each
// workload, a recommended request with headroom, a verdict, and the saving.
// The handler supplies pods, usage samples and the $ rates; everything here
// is unit-tested on plain objects. Wire casing: snake_case.

import type { V1Pod } from '@kubernetes/client-node';

import { parseCpu, parseMemory } from './quantity';

// ---------------------------------------------------------------------------
// Wire types (mirrored in src/lib/types/rightsizing.ts)
// ---------------------------------------------------------------------------

export type RightsizingVerdict = 'over' | 'under' | 'ok' | 'no-request' | 'no-data';

export interface ContainerRightsizing {
  container: string;
  cpu_request: number | null;
  memory_request: number | null;
  cpu_limit: number | null;
  memory_limit: number | null;
  /** Per-pod observed usage (average across the workload's pods). */
  cpu_usage: number | null;
  memory_usage: number | null;
  cpu_recommended: number | null;
  memory_recommended: number | null;
  cpu_verdict: RightsizingVerdict;
  memory_verdict: RightsizingVerdict;
}

export interface WorkloadRightsizing {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  replicas: number;
  containers: ContainerRightsizing[];
  /** Worst verdict across containers and resources: under beats over beats ok. */
  verdict: RightsizingVerdict;
  /** Monthly $ delta if recommendations were applied (positive = saving). */
  saving_monthly: number;
  /** Cores / bytes freed per month across replicas (negative = needs more). */
  cpu_delta: number;
  memory_delta: number;
}

export interface RightsizingOverview {
  scope: 'cluster' | 'namespace';
  namespace: string | null;
  workloads: WorkloadRightsizing[];
  /** "prometheus-p95-7d" | "metrics-server" | "none" */
  usage_source: string;
  usage_window: string;
  cpu_rate_per_core_hour: number;
  memory_rate_per_gb_hour: number;
  total_saving_monthly: number;
  over_count: number;
  under_count: number;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const CPU_HEADROOM = 1.3;
export const MEMORY_HEADROOM = 1.25;
/** Below this usage we do not recommend shrinking further. */
export const MIN_CPU_REQUEST = 0.01; // 10m
export const MIN_MEMORY_REQUEST = 32 * 1024 * 1024; // 32Mi
/** Over-provisioned when the request is more than this × recommendation. */
export const OVER_FACTOR = 1.5;
/** Under-provisioned when usage exceeds this share of the request. */
export const UNDER_SHARE = 0.9;
const HOURS_PER_MONTH = 730;
const GB = 1024 ** 3;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Usage for one container of one pod: cores and bytes. */
export interface UsageSample {
  namespace: string;
  pod: string;
  container: string;
  cpu: number | null;
  memory: number | null;
}

export function usageKey(namespace: string, pod: string, container: string): string {
  return `${namespace}/${pod}/${container}`;
}

export interface WorkloadRef {
  kind: string;
  name: string;
}

/** The workload a pod belongs to: Deployment via its ReplicaSet, STS/DS/Job directly, else the pod itself. */
export function workloadOf(pod: V1Pod): WorkloadRef {
  const ref = pod.metadata?.ownerReferences?.find((r) => r.controller) ?? pod.metadata?.ownerReferences?.[0];
  if (!ref) return { kind: 'Pod', name: pod.metadata?.name ?? '' };
  if (ref.kind === 'ReplicaSet') {
    const idx = ref.name.lastIndexOf('-');
    return { kind: 'Deployment', name: idx > 0 ? ref.name.slice(0, idx) : ref.name };
  }
  return { kind: ref.kind, name: ref.name };
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/** Round a CPU request up to a tidy step: 5m under 100m, 10m under 1 core, 50m above. */
export function roundCpu(cores: number): number {
  const m = cores * 1000;
  const step = m < 100 ? 5 : m < 1000 ? 10 : 50;
  return Math.ceil(m / step) * step / 1000;
}

/** Round a memory request up to a tidy step: 8Mi under 256Mi, 32Mi under 2Gi, 128Mi above. */
export function roundMemory(bytes: number): number {
  const mi = bytes / (1024 * 1024);
  const step = mi < 256 ? 8 : mi < 2048 ? 32 : 128;
  return Math.ceil(mi / step) * step * 1024 * 1024;
}

export function recommendCpu(usage: number): number {
  return Math.max(MIN_CPU_REQUEST, roundCpu(usage * CPU_HEADROOM));
}

export function recommendMemory(usage: number): number {
  return Math.max(MIN_MEMORY_REQUEST, roundMemory(usage * MEMORY_HEADROOM));
}

export function verdictFor(request: number | null, usage: number | null, recommended: number | null): RightsizingVerdict {
  if (usage === null || recommended === null) return 'no-data';
  if (request === null || request === 0) return 'no-request';
  if (usage > request * UNDER_SHARE) return 'under';
  if (request > recommended * OVER_FACTOR) return 'over';
  return 'ok';
}

const VERDICT_RANK: Record<RightsizingVerdict, number> = { under: 0, over: 1, 'no-request': 2, ok: 3, 'no-data': 4 };

export function worstVerdict(verdicts: RightsizingVerdict[]): RightsizingVerdict {
  return verdicts.reduce<RightsizingVerdict>((w, v) => (VERDICT_RANK[v] < VERDICT_RANK[w] ? v : w), 'no-data');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface Rates {
  cpu: number;
  memory: number;
}

interface ContainerAcc {
  cpu_request: number | null;
  memory_request: number | null;
  cpu_limit: number | null;
  memory_limit: number | null;
  cpuSamples: number[];
  memSamples: number[];
}

function q(v: string | undefined, parse: (s: string) => number): number | null {
  return v ? parse(v) : null;
}

/**
 * Group the pods of a scope by workload, average each container's usage over
 * the workload's pods, recommend and judge. Only Running pods count — a
 * Completed job pod has no usage to learn from, and a Pending one no pod.
 */
export function buildRightsizing(
  pods: V1Pod[],
  usage: Map<string, UsageSample>,
  rates: Rates,
): WorkloadRightsizing[] {
  const groups = new Map<string, { ref: WorkloadRef; namespace: string; pods: number; containers: Map<string, ContainerAcc> }>();
  for (const pod of pods) {
    if (pod.status?.phase !== 'Running' || pod.metadata?.deletionTimestamp) continue;
    const ns = pod.metadata?.namespace ?? '';
    const podName = pod.metadata?.name ?? '';
    const ref = workloadOf(pod);
    const id = `${ref.kind}/${ns}/${ref.name}`;
    let g = groups.get(id);
    if (!g) {
      g = { ref, namespace: ns, pods: 0, containers: new Map() };
      groups.set(id, g);
    }
    g.pods += 1;
    for (const c of pod.spec?.containers ?? []) {
      let acc = g.containers.get(c.name);
      if (!acc) {
        acc = {
          cpu_request: q(c.resources?.requests?.cpu, parseCpu),
          memory_request: q(c.resources?.requests?.memory, parseMemory),
          cpu_limit: q(c.resources?.limits?.cpu, parseCpu),
          memory_limit: q(c.resources?.limits?.memory, parseMemory),
          cpuSamples: [],
          memSamples: [],
        };
        g.containers.set(c.name, acc);
      }
      const u = usage.get(usageKey(ns, podName, c.name));
      if (u?.cpu !== null && u?.cpu !== undefined) acc.cpuSamples.push(u.cpu);
      if (u?.memory !== null && u?.memory !== undefined) acc.memSamples.push(u.memory);
    }
  }

  const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const out: WorkloadRightsizing[] = [];
  for (const [id, g] of groups) {
    const containers: ContainerRightsizing[] = [];
    let cpuDelta = 0;
    let memDelta = 0;
    for (const [name, acc] of g.containers) {
      const cpuUsage = avg(acc.cpuSamples);
      const memUsage = avg(acc.memSamples);
      const cpuRec = cpuUsage === null ? null : recommendCpu(cpuUsage);
      const memRec = memUsage === null ? null : recommendMemory(memUsage);
      const cpuVerdict = verdictFor(acc.cpu_request, cpuUsage, cpuRec);
      const memVerdict = verdictFor(acc.memory_request, memUsage, memRec);
      if (cpuRec !== null && acc.cpu_request !== null && (cpuVerdict === 'over' || cpuVerdict === 'under')) cpuDelta += (acc.cpu_request - cpuRec) * g.pods;
      if (memRec !== null && acc.memory_request !== null && (memVerdict === 'over' || memVerdict === 'under')) memDelta += (acc.memory_request - memRec) * g.pods;
      containers.push({
        container: name,
        cpu_request: acc.cpu_request,
        memory_request: acc.memory_request,
        cpu_limit: acc.cpu_limit,
        memory_limit: acc.memory_limit,
        cpu_usage: cpuUsage,
        memory_usage: memUsage,
        cpu_recommended: cpuRec,
        memory_recommended: memRec,
        cpu_verdict: cpuVerdict,
        memory_verdict: memVerdict,
      });
    }
    const saving = (cpuDelta * rates.cpu + (memDelta / GB) * rates.memory) * HOURS_PER_MONTH;
    out.push({
      id,
      kind: g.ref.kind,
      name: g.ref.name,
      namespace: g.namespace,
      replicas: g.pods,
      containers,
      verdict: worstVerdict(containers.flatMap((c) => [c.cpu_verdict, c.memory_verdict])),
      saving_monthly: saving,
      cpu_delta: cpuDelta,
      memory_delta: memDelta,
    });
  }
  // Biggest saving first; under-provisioned (negative saving) still float up
  // by magnitude because they need attention too.
  out.sort((a, b) => Math.abs(b.saving_monthly) - Math.abs(a.saving_monthly) || a.name.localeCompare(b.name));
  return out;
}

export function summarize(workloads: WorkloadRightsizing[]): { total_saving_monthly: number; over_count: number; under_count: number } {
  let total = 0;
  let over = 0;
  let under = 0;
  for (const w of workloads) {
    if (w.saving_monthly > 0) total += w.saving_monthly;
    if (w.verdict === 'over') over++;
    if (w.verdict === 'under') under++;
  }
  return { total_saving_monthly: total, over_count: over, under_count: under };
}
