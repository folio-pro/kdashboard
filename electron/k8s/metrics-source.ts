// metrics.k8s.io, read once for everyone: the typed Metrics client, the
// availability backoff (a cluster without metrics-server is asked again only
// every 30 s → 5 min, not on every refresh of every view) and the per-pod /
// per-node usage shapes. cost, metrics, overview and rightsizing all used to
// construct their own client and parse `usage.cpu` themselves.

import type { NodeMetric, PodMetric } from '@kubernetes/client-node';

import { apiGet } from './api.js';
import { parseCpu, parseMemory } from './quantity.js';

// ---------------------------------------------------------------------------
// Wire shapes (renderer mirror: src/lib/types/metrics.ts)
// ---------------------------------------------------------------------------

export interface ContainerUsage {
  name: string;
  cpu_cores: number;
  memory_bytes: number;
}

export interface PodUsageInfo {
  name: string;
  namespace: string;
  cpu_cores: number;
  memory_bytes: number;
  containers: ContainerUsage[];
}

export interface NodeUsage {
  cpu: number;
  memory: number;
}

// ---------------------------------------------------------------------------
// Availability backoff
// ---------------------------------------------------------------------------

type MetricsKind = 'pods' | 'nodes';

interface AvailabilityState {
  unavailableUntil: number | null; // epoch ms
  consecutiveFailures: number;
}

const BACKOFF_STEPS_SECS = [30, 60, 120, 300];

const availabilityState: Record<MetricsKind, AvailabilityState> = {
  pods: { unavailableUntil: null, consecutiveFailures: 0 },
  nodes: { unavailableUntil: null, consecutiveFailures: 0 },
};

function metricsAvailable(kind: MetricsKind): boolean {
  const s = availabilityState[kind];
  if (s.unavailableUntil === null) return true;
  return Date.now() >= s.unavailableUntil;
}

function markMetricsAvailable(kind: MetricsKind): void {
  const s = availabilityState[kind];
  s.unavailableUntil = null;
  s.consecutiveFailures = 0;
}

function markMetricsUnavailable(kind: MetricsKind): number {
  const s = availabilityState[kind];
  const step = Math.min(s.consecutiveFailures, BACKOFF_STEPS_SECS.length - 1);
  const secs = BACKOFF_STEPS_SECS[step];
  s.consecutiveFailures += 1;
  s.unavailableUntil = Date.now() + secs * 1000;
  return secs;
}

/** Forget the backoff (tests, or when the user points at another cluster). */
export function resetMetricsAvailability(): void {
  for (const kind of Object.keys(availabilityState) as MetricsKind[]) {
    availabilityState[kind] = { unavailableUntil: null, consecutiveFailures: 0 };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Raw reads rather than client-node's `Metrics` class: that one builds its
// own https.Agent per request (fresh TLS handshake, CA/cert file reads), which
// the pods table paid once per poll. apiGet rides the shared auth cache and
// keep-alive dispatcher like every other request.
const METRICS_BASE = '/apis/metrics.k8s.io/v1beta1';

function listPodMetrics(namespace?: string): Promise<{ items: PodMetric[] }> {
  const path = namespace
    ? `${METRICS_BASE}/namespaces/${encodeURIComponent(namespace)}/pods`
    : `${METRICS_BASE}/pods`;
  return apiGet<{ items: PodMetric[] }>(path);
}

function listNodeMetrics(): Promise<{ items: NodeMetric[] }> {
  return apiGet<{ items: NodeMetric[] }>(`${METRICS_BASE}/nodes`);
}

/** Sum the per-container usage into the pod totals the table renders. */
export function podUsageFrom(pm: PodMetric): PodUsageInfo {
  const containers: ContainerUsage[] = pm.containers.map((c) => ({
    name: c.name,
    cpu_cores: parseCpu(c.usage.cpu),
    memory_bytes: parseMemory(c.usage.memory),
  }));
  return {
    name: pm.metadata.name,
    namespace: pm.metadata.namespace,
    cpu_cores: containers.reduce((sum, c) => sum + c.cpu_cores, 0),
    memory_bytes: containers.reduce((sum, c) => sum + c.memory_bytes, 0),
    containers,
  };
}

/**
 * Pod usage in `namespace` (all namespaces when undefined). Throws when
 * metrics-server is unavailable — quickly, without a request, while the
 * backoff is in force.
 */
export async function podUsage(namespace?: string): Promise<PodUsageInfo[]> {
  if (!metricsAvailable('pods')) {
    throw new Error('metrics-server pods endpoint marked unavailable; backing off');
  }
  try {
    const list = await listPodMetrics(namespace);
    markMetricsAvailable('pods');
    return list.items.map(podUsageFrom);
  } catch (err) {
    markMetricsUnavailable('pods');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Cluster-wide pod usage, falling back to `namespace` when that is refused. */
export async function podUsageScoped(namespace: string | null): Promise<PodUsageInfo[]> {
  try {
    return await podUsage();
  } catch (err) {
    if (!namespace) throw err;
    return podUsage(namespace);
  }
}

/** Node usage keyed by node name. Throws when unavailable (see podUsage). */
export async function nodeUsage(): Promise<Map<string, NodeUsage>> {
  if (!metricsAvailable('nodes')) {
    throw new Error('metrics-server nodes endpoint marked unavailable; backing off');
  }
  try {
    const list = await listNodeMetrics();
    markMetricsAvailable('nodes');
    const map = new Map<string, NodeUsage>();
    for (const m of list.items) map.set(m.metadata.name, { cpu: parseCpu(m.usage.cpu), memory: parseMemory(m.usage.memory) });
    return map;
  } catch (err) {
    markMetricsUnavailable('nodes');
    throw err instanceof Error ? err : new Error(String(err));
  }
}
