// Cluster overview — pure summarisation of typed k8s objects into the wire
// shape the Overview and Problems views render. No API calls here; the
// handler (handlers/overview.ts) fetches and this module judges, so every
// rule is unit-testable on plain objects. Wire casing: snake_case.

import type {
  CoreV1Event,
  V1DaemonSet,
  V1Deployment,
  V1Job,
  V1Node,
  V1Pod,
  V1StatefulSet,
} from '@kubernetes/client-node';

import { parseCpu, parseMemory } from './quantity';

// ---------------------------------------------------------------------------
// Wire types (mirrored in src/lib/types/overview.ts)
// ---------------------------------------------------------------------------

export interface NodeSummary {
  name: string;
  ready: boolean;
  /** Condition types that are True and mean trouble: MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable. */
  pressure: string[];
  unschedulable: boolean;
  instance_type: string | null;
  zone: string | null;
  kubelet_version: string | null;
  cpu_allocatable: number;
  memory_allocatable: number;
  /** Sum of container requests of the pods scheduled here; null when pods could not be listed. */
  cpu_requests: number | null;
  memory_requests: number | null;
  pod_count: number | null;
  /** metrics.k8s.io usage, when available. */
  cpu_usage: number | null;
  memory_usage: number | null;
  age: string | null;
}

export interface PodPhaseCounts {
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  unknown: number;
  total: number;
}

export type ProblemSeverity = 'critical' | 'warning';

export interface Problem {
  /** Stable id for selection: kind/namespace/name. */
  id: string;
  severity: ProblemSeverity;
  kind: 'Pod' | 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'Node';
  name: string;
  namespace: string | null;
  /** Short reason: CrashLoopBackOff, Unavailable, 2/3 ready, MemoryPressure… */
  reason: string;
  /** One sentence of detail (container message, condition message…). */
  detail: string | null;
  /** The workload behind a pod (kind/name), when it has one. */
  owner: string | null;
  /** ISO timestamp the problem can be dated from (last transition / termination / creation). */
  since: string | null;
  restarts: number;
  /** Ready / desired for workloads, null for pods and nodes. */
  ready: number | null;
  desired: number | null;
}

export interface WarningEvent {
  reason: string;
  message: string;
  kind: string;
  name: string;
  namespace: string | null;
  count: number;
  last_timestamp: string | null;
}

export interface TopPod {
  name: string;
  namespace: string;
  cpu_usage: number;
  memory_usage: number;
}

export interface ClusterOverview {
  /** "cluster" when lists were cluster-wide, "namespace" when scoped to one. */
  scope: 'cluster' | 'namespace';
  namespace: string | null;
  nodes: NodeSummary[];
  pods: PodPhaseCounts;
  problems: Problem[];
  warnings: WarningEvent[];
  warnings_total: number;
  top_pods_cpu: TopPod[];
  top_pods_memory: TopPod[];
  metrics_available: boolean;
  /** Kinds that could not be listed (RBAC or API errors) — the UI says so. */
  partial: string[];
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRESSURE_CONDITIONS = new Set(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']);
const BROKEN_REASON = /error|crash|backoff|oom|invalid|cannotrun|deadline|killed/i;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function iso(d: Date | string | undefined | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function podRequests(pod: V1Pod): { cpu: number; memory: number } {
  let cpu = 0;
  let memory = 0;
  for (const c of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]) {
    // Init containers request sequentially; the pod's effective request is
    // max(init, sum(app)). Approximate with app containers only — that is what
    // the scheduler reserves for the pod's lifetime.
    if (pod.spec?.initContainers?.includes(c)) continue;
    const r = c.resources?.requests;
    if (r?.cpu) cpu += parseCpu(r.cpu);
    if (r?.memory) memory += parseMemory(r.memory);
  }
  return { cpu, memory };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface NodeUsage {
  cpu: number;
  memory: number;
}

export function summarizeNodes(
  nodes: V1Node[],
  pods: V1Pod[] | null,
  usage: Map<string, NodeUsage> | null,
): NodeSummary[] {
  const perNode = new Map<string, { cpu: number; memory: number; count: number }>();
  if (pods) {
    for (const pod of pods) {
      const node = pod.spec?.nodeName;
      if (!node) continue;
      const phase = pod.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') continue; // released its requests
      const req = podRequests(pod);
      const entry = perNode.get(node) ?? { cpu: 0, memory: 0, count: 0 };
      entry.cpu += req.cpu;
      entry.memory += req.memory;
      entry.count += 1;
      perNode.set(node, entry);
    }
  }
  return nodes
    .map((n): NodeSummary => {
      const name = n.metadata?.name ?? '';
      const conds = n.status?.conditions ?? [];
      const ready = conds.some((c) => c.type === 'Ready' && c.status === 'True');
      const pressure = conds.filter((c) => PRESSURE_CONDITIONS.has(c.type) && c.status === 'True').map((c) => c.type);
      const labels = n.metadata?.labels ?? {};
      const alloc = n.status?.allocatable ?? {};
      const req = perNode.get(name);
      const u = usage?.get(name);
      return {
        name,
        ready,
        pressure,
        unschedulable: n.spec?.unschedulable === true,
        instance_type: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? null,
        zone: labels['topology.kubernetes.io/zone'] ?? labels['failure-domain.beta.kubernetes.io/zone'] ?? null,
        kubelet_version: n.status?.nodeInfo?.kubeletVersion ?? null,
        cpu_allocatable: alloc.cpu ? parseCpu(alloc.cpu) : 0,
        memory_allocatable: alloc.memory ? parseMemory(alloc.memory) : 0,
        cpu_requests: pods ? (req?.cpu ?? 0) : null,
        memory_requests: pods ? (req?.memory ?? 0) : null,
        pod_count: pods ? (req?.count ?? 0) : null,
        cpu_usage: u?.cpu ?? null,
        memory_usage: u?.memory ?? null,
        age: iso(n.metadata?.creationTimestamp),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function nodeProblems(nodes: NodeSummary[]): Problem[] {
  const out: Problem[] = [];
  for (const n of nodes) {
    if (!n.ready) {
      out.push(problem('critical', 'Node', n.name, null, 'NotReady', n.pressure.length ? `Also: ${n.pressure.join(', ')}` : null, null));
    } else if (n.pressure.length > 0) {
      out.push(problem('warning', 'Node', n.name, null, n.pressure.join(', '), null, null));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

export function podPhaseCounts(pods: V1Pod[]): PodPhaseCounts {
  const c: PodPhaseCounts = { running: 0, pending: 0, succeeded: 0, failed: 0, unknown: 0, total: pods.length };
  for (const p of pods) {
    switch (p.status?.phase) {
      case 'Running': c.running++; break;
      case 'Pending': c.pending++; break;
      case 'Succeeded': c.succeeded++; break;
      case 'Failed': c.failed++; break;
      default: c.unknown++;
    }
  }
  return c;
}

function problem(
  severity: ProblemSeverity,
  kind: Problem['kind'],
  name: string,
  namespace: string | null,
  reason: string,
  detail: string | null,
  since: string | null,
  extra: Partial<Problem> = {},
): Problem {
  return {
    id: `${kind}/${namespace ?? ''}/${name}`,
    severity,
    kind,
    name,
    namespace,
    reason,
    detail,
    owner: null,
    since,
    restarts: 0,
    ready: null,
    desired: null,
    ...extra,
  };
}

function podOwner(pod: V1Pod): string | null {
  const ref = pod.metadata?.ownerReferences?.find((r) => r.controller) ?? pod.metadata?.ownerReferences?.[0];
  return ref ? `${ref.kind}/${ref.name}` : null;
}

/** The first thing wrong with a pod, or null. Mirrors the renderer's podProblem. */
export function podProblem(pod: V1Pod): Problem | null {
  const name = pod.metadata?.name ?? '';
  const ns = pod.metadata?.namespace ?? null;
  if (pod.metadata?.deletionTimestamp) return null; // going away on purpose
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []).map((s) => ({ s, init: true })),
    ...(pod.status?.containerStatuses ?? []).map((s) => ({ s, init: false })),
  ];
  let restarts = 0;
  for (const { s } of statuses) restarts += s.restartCount ?? 0;
  for (const { s, init } of statuses) {
    const w = s.state?.waiting;
    const t = s.state?.terminated;
    const last = s.lastState?.terminated;
    if (w?.reason && BROKEN_REASON.test(w.reason)) {
      const detail = [init ? `init container ${s.name}` : `container ${s.name}`, w.message ?? (last?.reason ? `last exit: ${last.reason}${last.exitCode !== undefined ? ` (${last.exitCode})` : ''}` : null)]
        .filter(Boolean)
        .join(' — ');
      return problem('critical', 'Pod', name, ns, w.reason, detail, iso(last?.finishedAt ?? pod.status?.startTime), { owner: podOwner(pod), restarts });
    }
    if (t && (t.exitCode ?? 0) !== 0 && !init) {
      return problem('critical', 'Pod', name, ns, t.reason ?? `ExitCode ${t.exitCode}`, `container ${s.name}${t.message ? ` — ${t.message}` : ''}`, iso(t.finishedAt), { owner: podOwner(pod), restarts });
    }
  }
  if (pod.status?.phase === 'Failed') {
    return problem('critical', 'Pod', name, ns, pod.status.reason ?? 'Failed', pod.status.message ?? null, iso(pod.status.startTime), { owner: podOwner(pod), restarts });
  }
  const scheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled');
  if (pod.status?.phase === 'Pending' && scheduled && scheduled.status !== 'True' && scheduled.reason) {
    return problem('warning', 'Pod', name, ns, scheduled.reason, scheduled.message ?? null, iso(scheduled.lastTransitionTime ?? pod.metadata?.creationTimestamp), { owner: podOwner(pod), restarts });
  }
  // Ready=False for a long-running pod that is not otherwise broken: probes failing.
  const ready = pod.status?.conditions?.find((c) => c.type === 'Ready');
  if (pod.status?.phase === 'Running' && ready && ready.status !== 'True' && ready.reason === 'ContainersNotReady') {
    return problem('warning', 'Pod', name, ns, 'NotReady', ready.message ?? null, iso(ready.lastTransitionTime), { owner: podOwner(pod), restarts });
  }
  return null;
}

export function podProblems(pods: V1Pod[]): Problem[] {
  const out: Problem[] = [];
  for (const p of pods) {
    const pr = podProblem(p);
    if (pr) out.push(pr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

export interface WorkloadLists {
  deployments: V1Deployment[];
  statefulsets: V1StatefulSet[];
  daemonsets: V1DaemonSet[];
  jobs: V1Job[];
}

export function workloadProblems(lists: Partial<WorkloadLists>): Problem[] {
  const out: Problem[] = [];
  for (const d of lists.deployments ?? []) {
    const name = d.metadata?.name ?? '';
    const ns = d.metadata?.namespace ?? null;
    const desired = d.spec?.replicas ?? 1;
    const ready = num(d.status?.readyReplicas);
    const conds = d.status?.conditions ?? [];
    const cond = (t: string) => conds.find((c) => c.type === t);
    const failure = cond('ReplicaFailure');
    const progressing = cond('Progressing');
    const available = cond('Available');
    const extra = { ready, desired, since: iso(progressing?.lastUpdateTime ?? available?.lastTransitionTime) };
    if (d.spec?.paused || desired === 0) continue;
    if (failure?.status === 'True') out.push(problem('critical', 'Deployment', name, ns, 'ReplicaFailure', failure.message ?? failure.reason ?? null, extra.since, extra));
    else if (progressing?.status === 'False') out.push(problem('critical', 'Deployment', name, ns, progressing.reason ?? 'Failed', progressing.message ?? null, extra.since, extra));
    else if (available?.status === 'False') out.push(problem('critical', 'Deployment', name, ns, 'Unavailable', available.message ?? available.reason ?? null, extra.since, extra));
    else if (ready < desired) out.push(problem('warning', 'Deployment', name, ns, `${ready}/${desired} ready`, progressing?.message ?? null, extra.since, extra));
  }
  for (const s of lists.statefulsets ?? []) {
    const desired = s.spec?.replicas ?? 1;
    const ready = num(s.status?.readyReplicas);
    if (desired > 0 && ready < desired) {
      out.push(problem(ready === 0 ? 'critical' : 'warning', 'StatefulSet', s.metadata?.name ?? '', s.metadata?.namespace ?? null, `${ready}/${desired} ready`, null, null, { ready, desired }));
    }
  }
  for (const ds of lists.daemonsets ?? []) {
    const desired = num(ds.status?.desiredNumberScheduled);
    const ready = num(ds.status?.numberReady);
    if (desired > 0 && ready < desired) {
      out.push(problem(ready === 0 ? 'critical' : 'warning', 'DaemonSet', ds.metadata?.name ?? '', ds.metadata?.namespace ?? null, `${ready}/${desired} ready`, null, null, { ready, desired }));
    }
  }
  for (const j of lists.jobs ?? []) {
    const conds = j.status?.conditions ?? [];
    const failed = conds.find((c) => c.type === 'Failed' && c.status === 'True');
    if (failed || num(j.status?.failed) > 0) {
      const complete = conds.some((c) => c.type === 'Complete' && c.status === 'True');
      if (complete) continue;
      out.push(problem(failed ? 'critical' : 'warning', 'Job', j.metadata?.name ?? '', j.metadata?.namespace ?? null, failed?.reason ?? `${num(j.status?.failed)} failed`, failed?.message ?? null, iso(failed?.lastTransitionTime ?? j.status?.startTime), {
        owner: j.metadata?.ownerReferences?.[0] ? `${j.metadata.ownerReferences[0].kind}/${j.metadata.ownerReferences[0].name}` : null,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function eventTime(e: CoreV1Event): string | null {
  return iso(e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp);
}

/** Warning events newer than `sinceMs`, newest first, capped. */
export function recentWarnings(events: CoreV1Event[], sinceMs: number, limit = 50): { items: WarningEvent[]; total: number } {
  const rows = events
    .filter((e) => e.type === 'Warning')
    .map((e): WarningEvent & { t: number } => {
      const ts = eventTime(e);
      return {
        reason: e.reason ?? '',
        message: e.message ?? '',
        kind: e.involvedObject?.kind ?? '',
        name: e.involvedObject?.name ?? '',
        namespace: e.involvedObject?.namespace ?? e.metadata?.namespace ?? null,
        count: e.count ?? e.series?.count ?? 1,
        last_timestamp: ts,
        t: ts ? new Date(ts).getTime() : 0,
      };
    })
    .filter((e) => e.t >= sinceMs)
    .sort((a, b) => b.t - a.t);
  return { items: rows.slice(0, limit).map(({ t, ...rest }) => { void t; return rest; }), total: rows.length };
}

// ---------------------------------------------------------------------------
// Problems: merge + order
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<ProblemSeverity, number> = { critical: 0, warning: 1 };
const KIND_RANK: Record<Problem['kind'], number> = { Node: 0, Deployment: 1, StatefulSet: 2, DaemonSet: 3, Job: 4, Pod: 5 };

/** Critical first, then nodes before workloads before pods, then oldest first. */
export function orderProblems(problems: Problem[]): Problem[] {
  return [...problems].sort((a, b) => {
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    const ta = a.since ? new Date(a.since).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.since ? new Date(b.since).getTime() : Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Hide pod problems that a workload problem already explains: a Deployment
 * reported 1/3 ready does not need its two CrashLoopBackOff pods listed
 * separately, but a crashing bare pod does.
 */
export function foldPodsIntoOwners(problems: Problem[]): Problem[] {
  const workloadIds = new Set(problems.filter((p) => p.kind !== 'Pod' && p.kind !== 'Node').map((p) => `${p.kind}/${p.namespace ?? ''}/${p.name}`));
  return problems.filter((p) => {
    if (p.kind !== 'Pod' || !p.owner) return true;
    const [ownerKind, ownerName] = p.owner.split('/');
    // ReplicaSets belong to Deployments: `<deploy>-<hash>`.
    if (ownerKind === 'ReplicaSet') {
      const idx = ownerName.lastIndexOf('-');
      const deploy = idx > 0 ? ownerName.slice(0, idx) : ownerName;
      return !workloadIds.has(`Deployment/${p.namespace ?? ''}/${deploy}`);
    }
    return !workloadIds.has(`${ownerKind}/${p.namespace ?? ''}/${ownerName}`);
  });
}
