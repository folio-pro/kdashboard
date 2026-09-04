// Cluster overview — pure summarisation of typed k8s objects into the wire
// shape the Overview and Problems views render. No API calls here; the
// handler (handlers/overview.ts) fetches and this module judges, so every
// rule is unit-testable on plain objects. Wire casing: snake_case.

import type {
  CoreV1Event,
  V1DaemonSet,
  V1Deployment,
  V1Endpoints,
  V1Job,
  V1Node,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node';

import { controllerRef, workloadKey, workloadOf } from './owners';
import { iso, podCause, worstPodCause, type PodCause, type PodRef, type ProblemCause } from './pod-cause';
import { parseCpu, parseMemory } from './quantity';

export type { PodRef, ProblemCause } from './pod-cause';

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

export type ProblemKind = 'Pod' | 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'Node' | 'PersistentVolumeClaim' | 'Service';

export interface Problem {
  /** Stable id for selection: kind/namespace/name. */
  id: string;
  severity: ProblemSeverity;
  kind: ProblemKind;
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
  /** Machine-readable category the UI keys its actions on. */
  cause: ProblemCause;
  /** The most relevant pod (a workload's worst pod, a job's last failed pod, the pod itself), or null. */
  pod: PodRef | null;
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

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function ms(d: Date | string | undefined | null): number | null {
  const s = iso(d);
  return s ? new Date(s).getTime() : null;
}

/** Sum of the app containers' requests — what the scheduler reserves for the
 *  pod's lifetime (init containers run and release before). */
export function podRequests(pod: V1Pod): { cpu: number; memory: number } {
  let cpu = 0;
  let memory = 0;
  for (const c of pod.spec?.containers ?? []) {
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
    cause: 'unknown',
    pod: null,
    ...extra,
  };
}

/** The workload behind a pod as "Kind/name" (Deployment for a ReplicaSet's pods), null for a bare pod. */
function podOwner(pod: V1Pod): string | null {
  const w = workloadOf(pod);
  return w.kind === 'Pod' ? null : workloadKey(w);
}

/**
 * Key of `podCausesByWorkload`: the namespace is part of it because a cluster
 * overview holds `Deployment/web` from several namespaces, and borrowing a pod
 * across them opened the wrong pod's logs.
 */
export function workloadPodKey(namespace: string | null | undefined, kind: string, name: string): string {
  return `${namespace ?? ''}/${kind}/${name}`;
}

/** The first thing wrong with a pod, or null. Mirrors the renderer's podProblem; the judgement itself lives in pod-cause.ts. */
export function podProblem(pod: V1Pod): Problem | null {
  const c = podCause(pod);
  if (!c) return null;
  return problem(c.severity, 'Pod', pod.metadata?.name ?? '', pod.metadata?.namespace ?? null, c.reason, c.detail, c.since, {
    owner: podOwner(pod),
    restarts: c.restarts,
    cause: c.cause,
    pod: c.pod,
  });
}

/** Broken pods grouped under the workload that owns them, keyed by `workloadPodKey`. */
export function podCausesByWorkload(pods: readonly V1Pod[]): Map<string, PodCause[]> {
  const out = new Map<string, PodCause[]>();
  for (const pod of pods) {
    const owner = workloadOf(pod);
    if (owner.kind === 'Pod') continue;
    const c = podCause(pod);
    if (!c) continue;
    const key = workloadPodKey(pod.metadata?.namespace, owner.kind, owner.name);
    const list = out.get(key) ?? [];
    list.push(c);
    out.set(key, list);
  }
  return out;
}

/** "pod-name: ImagePullBackOff — container app — Back-off pulling image" — the line a workload problem borrows from its worst pod. */
function podLine(c: PodCause): string {
  return `${c.pod.name}: ${c.reason}${c.detail ? ` — ${c.detail}` : ''}`;
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

/**
 * Workload problems. When `pods` is given, each problem borrows its cause,
 * pod reference and detail from the worst pod the workload owns, so a
 * Deployment reads "bad-image-abc: ImagePullBackOff — …" instead of the
 * controller's generic "does not have minimum availability".
 */
export function workloadProblems(lists: Partial<WorkloadLists>, pods: readonly V1Pod[] = []): Problem[] {
  const out: Problem[] = [];
  const byWorkload = podCausesByWorkload(pods);
  /** Cause / pod / detail borrowed from the worst owned pod; `fallback` when the workload has no broken pod. */
  const fromPods = (kind: ProblemKind, namespace: string | null, name: string, fallback: ProblemCause, detail: string | null): Partial<Problem> => {
    const worst = worstPodCause(byWorkload.get(workloadPodKey(namespace, kind, name)));
    if (!worst) return { cause: fallback, detail };
    return { cause: worst.cause, pod: worst.pod, detail: podLine(worst), restarts: worst.restarts };
  };

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
    const since = iso(progressing?.lastUpdateTime ?? available?.lastTransitionTime);
    const extra = (fallback: ProblemCause, detail: string | null) => ({ ready, desired, since, ...fromPods('Deployment', ns, name, fallback, detail) });
    if (d.spec?.paused || desired === 0) continue;
    if (failure?.status === 'True') out.push(problem('critical', 'Deployment', name, ns, 'ReplicaFailure', null, since, extra('unknown', failure.message ?? failure.reason ?? null)));
    else if (progressing?.status === 'False') out.push(problem('critical', 'Deployment', name, ns, progressing.reason ?? 'Failed', null, since, extra('progress-deadline', progressing.message ?? null)));
    else if (available?.status === 'False') out.push(problem('critical', 'Deployment', name, ns, 'Unavailable', null, since, extra('unknown', available.message ?? available.reason ?? null)));
    else if (ready < desired) out.push(problem('warning', 'Deployment', name, ns, `${ready}/${desired} ready`, null, since, extra('unknown', progressing?.message ?? null)));
  }
  for (const s of lists.statefulsets ?? []) {
    const name = s.metadata?.name ?? '';
    const desired = s.spec?.replicas ?? 1;
    const ready = num(s.status?.readyReplicas);
    if (desired > 0 && ready < desired) {
      out.push(problem(ready === 0 ? 'critical' : 'warning', 'StatefulSet', name, s.metadata?.namespace ?? null, `${ready}/${desired} ready`, null, null, { ready, desired, ...fromPods('StatefulSet', s.metadata?.namespace ?? null, name, 'unknown', null) }));
    }
  }
  for (const ds of lists.daemonsets ?? []) {
    const name = ds.metadata?.name ?? '';
    const desired = num(ds.status?.desiredNumberScheduled);
    const ready = num(ds.status?.numberReady);
    if (desired > 0 && ready < desired) {
      out.push(problem(ready === 0 ? 'critical' : 'warning', 'DaemonSet', name, ds.metadata?.namespace ?? null, `${ready}/${desired} ready`, null, null, { ready, desired, ...fromPods('DaemonSet', ds.metadata?.namespace ?? null, name, 'unknown', null) }));
    }
  }
  for (const j of lists.jobs ?? []) {
    const name = j.metadata?.name ?? '';
    const conds = j.status?.conditions ?? [];
    const failed = conds.find((c) => c.type === 'Failed' && c.status === 'True');
    if (failed || num(j.status?.failed) > 0) {
      const complete = conds.some((c) => c.type === 'Complete' && c.status === 'True');
      if (complete) continue;
      const ownerRef = controllerRef(j.metadata);
      const worst = worstPodCause(byWorkload.get(workloadPodKey(j.metadata?.namespace, 'Job', name)));
      const detail = [failed?.message ?? null, worst ? podLine(worst) : null].filter(Boolean).join(' · ') || null;
      out.push(problem(failed ? 'critical' : 'warning', 'Job', name, j.metadata?.namespace ?? null, failed?.reason ?? `${num(j.status?.failed)} failed`, detail, iso(failed?.lastTransitionTime ?? j.status?.startTime), {
        owner: ownerRef ? `${ownerRef.kind}/${ownerRef.name}` : null,
        cause: 'job-failed',
        pod: worst?.pod ?? null,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage and networking
// ---------------------------------------------------------------------------

/** A PVC may legitimately sit Pending for a moment (WaitForFirstConsumer); older than this it is stuck. */
export const PVC_PENDING_GRACE_MS = 2 * 60_000;
/** Cloud providers take a while to hand out an address; older than this the LoadBalancer is stuck. */
export const LB_PENDING_GRACE_MS = 5 * 60_000;

/** The newest event with `reason` about one object, or null. */
function latestEventFor(events: readonly CoreV1Event[], kind: string, namespace: string | null, name: string, reason: string): CoreV1Event | null {
  let best: CoreV1Event | null = null;
  let bestT = -1;
  for (const e of events) {
    const o = e.involvedObject;
    if (e.reason !== reason || o?.kind !== kind || o?.name !== name || (o?.namespace ?? e.metadata?.namespace ?? null) !== namespace) continue;
    const t = ms(eventTime(e)) ?? 0;
    if (t > bestT) { best = e; bestT = t; }
  }
  return best;
}

/** PVCs still Pending after the grace period — a warning carrying the provisioner's last complaint. */
export function pvcProblems(pvcs: readonly V1PersistentVolumeClaim[], events: readonly CoreV1Event[], now = Date.now()): Problem[] {
  const out: Problem[] = [];
  for (const pvc of pvcs) {
    if (pvc.status?.phase !== 'Pending' || pvc.metadata?.deletionTimestamp) continue;
    const name = pvc.metadata?.name ?? '';
    const ns = pvc.metadata?.namespace ?? null;
    const created = ms(pvc.metadata?.creationTimestamp);
    if (created === null || now - created < PVC_PENDING_GRACE_MS) continue;
    const failed = latestEventFor(events, 'PersistentVolumeClaim', ns, name, 'ProvisioningFailed');
    // A WaitForFirstConsumer class binds when a pod first mounts the claim;
    // an unused claim staying Pending is by design, not a problem.
    if (!failed && latestEventFor(events, 'PersistentVolumeClaim', ns, name, 'WaitForFirstConsumer')) continue;
    const sc = pvc.spec?.storageClassName;
    const detail = failed?.message ?? (sc ? `waiting for a volume from storage class "${sc}"` : 'waiting for a volume');
    out.push(problem('warning', 'PersistentVolumeClaim', name, ns, 'Pending', detail, iso(pvc.metadata?.creationTimestamp), { cause: 'pvc-pending' }));
  }
  return out;
}

function readyAddresses(ep: V1Endpoints | undefined): number {
  let n = 0;
  for (const subset of ep?.subsets ?? []) n += subset.addresses?.length ?? 0;
  return n;
}

/**
 * Selector Services with no ready endpoint, and LoadBalancers still waiting
 * for an address. `endpoints` is null when Endpoints could not be listed; the
 * endpoint check is then skipped rather than reporting every Service empty.
 * One problem per Service (ids are kind/namespace/name): "No endpoints" wins
 * and mentions the pending LoadBalancer when both apply.
 */
export function serviceProblems(services: readonly V1Service[], endpoints: readonly V1Endpoints[] | null, now = Date.now()): Problem[] {
  const out: Problem[] = [];
  const byKey = new Map<string, V1Endpoints>();
  for (const ep of endpoints ?? []) byKey.set(`${ep.metadata?.namespace ?? ''}/${ep.metadata?.name ?? ''}`, ep);
  for (const svc of services) {
    if (svc.metadata?.deletionTimestamp) continue;
    const type = svc.spec?.type ?? 'ClusterIP';
    if (type === 'ExternalName') continue;
    const name = svc.metadata?.name ?? '';
    const ns = svc.metadata?.namespace ?? null;
    const selector = svc.spec?.selector ?? {};
    const selectorText = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',');
    const noEndpoints = selectorText !== '' && endpoints !== null && readyAddresses(byKey.get(`${ns ?? ''}/${name}`)) === 0;
    const created = ms(svc.metadata?.creationTimestamp);
    const hasAddress = (svc.status?.loadBalancer?.ingress ?? []).some((i) => i.ip || i.hostname);
    const lbPending = type === 'LoadBalancer' && !hasAddress && created !== null && now - created >= LB_PENDING_GRACE_MS;
    const since = iso(svc.metadata?.creationTimestamp);
    if (noEndpoints) {
      out.push(problem('warning', 'Service', name, ns, 'No endpoints', `selector ${selectorText} matches no ready pod${lbPending ? '; the LoadBalancer has no external address yet either' : ''}`, since, { cause: 'no-endpoints' }));
    } else if (lbPending) {
      out.push(problem('warning', 'Service', name, ns, 'LoadBalancer pending', 'no external IP or hostname has been assigned by the cloud provider', since, { cause: 'lb-pending' }));
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
const KIND_RANK: Record<Problem['kind'], number> = { Node: 0, Deployment: 1, StatefulSet: 2, DaemonSet: 3, Job: 4, Pod: 5, PersistentVolumeClaim: 6, Service: 7 };

/** Critical first, then nodes before workloads before pods before storage/networking, then oldest first. */
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
 * separately, but a crashing bare pod does. `Problem.owner` already names the
 * workload ("Deployment/web"), so this is a set lookup.
 */
export function foldPodsIntoOwners(problems: Problem[]): Problem[] {
  const workloadIds = new Set(problems.filter((p) => p.kind !== 'Pod' && p.kind !== 'Node').map((p) => `${p.kind}/${p.namespace ?? ''}/${p.name}`));
  return problems.filter((p) => {
    if (p.kind !== 'Pod' || !p.owner) return true;
    const [ownerKind, ownerName] = p.owner.split('/');
    return !workloadIds.has(`${ownerKind}/${p.namespace ?? ''}/${ownerName}`);
  });
}
