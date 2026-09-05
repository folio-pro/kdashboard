// Cost handlers — node pricing, pod usage, and the per-namespace cost overview.
//
// Commands: get_cost_overview, get_node_costs, get_node_metrics, refresh_pricing
//
// Notes:
//   - Wire shapes (CostOverview / NamespaceCostSummary / ResourceCost /
//     NodeCostInfo / NodeMetricsInfo) use snake_case field names; the renderer's
//     TS interfaces in src/lib/types/cost.ts mirror that casing exactly.
//   - Pricing (datasets, node info, rates) lives in electron/k8s/pricing.ts;
//     metrics.k8s.io access in electron/k8s/metrics-source.ts.
//   - get_cost_overview joins node costs + pod usage (or pod requests fallback).

import type { V1Pod } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api, onConfigChange } from '../k8s/client';
import { nodeUsage, podUsage } from '../k8s/metrics-source';
import {
  HOURS_PER_MONTH,
  clearPricingCache,
  currentRates,
  getNodeInfo,
  resolvePricing,
  type NodeInfo,
} from '../k8s/pricing';
import { parseCpu, parseMemory } from '../k8s/quantity';

// ---------------------------------------------------------------------------
// Public wire types (match src/lib/types/cost.ts).
// ---------------------------------------------------------------------------

interface ResourceCost {
  name: string;
  namespace: string;
  kind: string;
  cpu_cores: number;
  memory_bytes: number;
  cpu_cost_hourly: number;
  memory_cost_hourly: number;
  total_cost_hourly: number;
  total_cost_monthly: number;
}

interface NamespaceCostSummary {
  namespace: string;
  total_cpu_cores: number;
  total_memory_gb: number;
  total_cost_hourly: number;
  total_cost_monthly: number;
  workload_count: number;
  workloads: ResourceCost[];
}

interface CostOverview {
  namespaces: NamespaceCostSummary[];
  cluster_cost_hourly: number;
  cluster_cost_monthly: number;
  total_cpu_cores: number;
  total_memory_gb: number;
  cpu_rate_per_core_hour: number;
  memory_rate_per_gb_hour: number;
  source: string; // "cloud-pricing" | "fallback" | "requests"
  fetched_at: string;
}

interface NodeMetricsInfo {
  node_name: string;
  cpu_usage: number; // cores
  cpu_capacity: number; // cores
  cpu_percent: number; // 0-100
  memory_usage: number; // bytes
  memory_capacity: number; // bytes
  memory_percent: number; // 0-100
}

interface NodeCostInfo {
  node_name: string;
  instance_type: string;
  provider: string;
  region: string;
  price_per_hour: number;
  price_per_month: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A pod's per-container resource usage (from metrics-server or requests). */
interface PodUsage {
  name: string;
  namespace: string;
  containers: Array<{ cpu: string; memory: string }>;
}


const COST_CACHE_TTL_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Pod requests fallback (when metrics-server is unavailable)
// ---------------------------------------------------------------------------

async function getPodRequests(namespace: string | undefined): Promise<PodUsage[]> {
  const core = getCoreV1Api();
  const list =
    namespace !== undefined
      ? await core.listNamespacedPod({ namespace })
      : await core.listPodForAllNamespaces();

  const result: PodUsage[] = [];
  for (const pod of list.items as V1Pod[]) {
    const name = pod.metadata?.name ?? '';
    const ns = pod.metadata?.namespace ?? '';
    const containers: Array<{ cpu: string; memory: string }> = [];

    for (const c of pod.spec?.containers ?? []) {
      const requests = c.resources?.requests;
      const cpu = requests?.['cpu'] ?? '100m';
      const memory = requests?.['memory'] ?? '128Mi';
      containers.push({ cpu, memory });
    }

    if (containers.length > 0) {
      result.push({ name, namespace: ns, containers });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cost overview build + cache
// ---------------------------------------------------------------------------

interface CostCacheEntry {
  data: CostOverview;
  expiresAt: number; // epoch ms
}

/**
 * Overview cache keyed by namespace ('__all__' for the cluster-wide view) so a
 * namespace switch inside the TTL never serves another namespace's data.
 * Bounded: beyond COST_CACHE_MAX_ENTRIES the oldest entry is evicted (Map
 * preserves insertion order). Invalidated on context switch.
 */
const COST_CACHE_ALL_KEY = '__all__';
const COST_CACHE_MAX_ENTRIES = 20;
const costCache = new Map<string, CostCacheEntry>();


async function buildCostFromMetrics(namespace: string | undefined): Promise<CostOverview> {
  // metrics-server usage when available, else the pods' resource requests.
  let podMetrics: PodUsage[];
  let metricsSource: boolean;
  try {
    podMetrics = (await podUsage(namespace)).map((p) => ({
      name: p.name,
      namespace: p.namespace,
      containers: p.containers.map((c) => ({ cpu: String(c.cpu_cores), memory: String(c.memory_bytes) })),
    }));
    metricsSource = true;
  } catch {
    podMetrics = await getPodRequests(namespace);
    metricsSource = false;
  }

  const rates = await currentRates();
  const cpuRate = rates.cpu;
  const memRate = rates.memory;
  // Cloud pricing when resolved; else the fallback rates, labelled by where
  // the usage numbers came from.
  const source = rates.source === 'cloud-pricing' ? 'cloud-pricing' : metricsSource ? 'fallback' : 'requests';

  // Group by namespace.
  const nsMap = new Map<string, ResourceCost[]>();
  for (const pm of podMetrics) {
    let cpuTotal = 0;
    let memTotal = 0;
    for (const c of pm.containers) {
      cpuTotal += parseCpu(c.cpu);
      memTotal += parseMemory(c.memory);
    }
    const cpuCost = cpuTotal * cpuRate;
    const memCost = (memTotal / (1024.0 * 1024.0 * 1024.0)) * memRate;
    const totalHourly = cpuCost + memCost;

    let bucket = nsMap.get(pm.namespace);
    if (bucket === undefined) {
      bucket = [];
      nsMap.set(pm.namespace, bucket);
    }
    bucket.push({
      name: pm.name,
      namespace: pm.namespace,
      kind: 'Pod',
      cpu_cores: cpuTotal,
      memory_bytes: memTotal,
      cpu_cost_hourly: cpuCost,
      memory_cost_hourly: memCost,
      total_cost_hourly: totalHourly,
      total_cost_monthly: totalHourly * HOURS_PER_MONTH,
    });
  }

  const namespaces: NamespaceCostSummary[] = [];
  for (const [ns, workloads] of nsMap) {
    const totalCpu = workloads.reduce((acc, w) => acc + w.cpu_cores, 0);
    const totalMem = workloads.reduce((acc, w) => acc + w.memory_bytes, 0);
    const totalHourly = workloads.reduce((acc, w) => acc + w.total_cost_hourly, 0);
    namespaces.push({
      namespace: ns,
      total_cpu_cores: totalCpu,
      total_memory_gb: totalMem / (1024.0 * 1024.0 * 1024.0),
      total_cost_hourly: totalHourly,
      total_cost_monthly: totalHourly * HOURS_PER_MONTH,
      workload_count: workloads.length,
      workloads,
    });
  }

  namespaces.sort((a, b) => b.total_cost_monthly - a.total_cost_monthly);

  const clusterHourly = namespaces.reduce((acc, n) => acc + n.total_cost_hourly, 0);
  const totalCpu = namespaces.reduce((acc, n) => acc + n.total_cpu_cores, 0);
  const totalMem = namespaces.reduce((acc, n) => acc + n.total_memory_gb, 0);

  return {
    namespaces,
    cluster_cost_hourly: clusterHourly,
    cluster_cost_monthly: clusterHourly * HOURS_PER_MONTH,
    total_cpu_cores: totalCpu,
    total_memory_gb: totalMem,
    cpu_rate_per_core_hour: cpuRate,
    memory_rate_per_gb_hour: memRate,
    source,
    fetched_at: new Date().toISOString(),
  };
}

async function getCostOverview(namespace: string | null | undefined): Promise<CostOverview> {
  const ns =
    namespace && namespace !== 'All Namespaces' && namespace.length > 0
      ? namespace
      : undefined;
  const cacheKey = ns ?? COST_CACHE_ALL_KEY;

  // Cache check (per-namespace entry, 5 min TTL).
  const hit = costCache.get(cacheKey);
  if (hit !== undefined && hit.expiresAt > Date.now()) {
    return hit.data;
  }

  const result = await buildCostFromMetrics(ns);

  // Re-insert so the entry moves to the back of the eviction order.
  costCache.delete(cacheKey);
  costCache.set(cacheKey, { data: result, expiresAt: Date.now() + COST_CACHE_TTL_MS });
  if (costCache.size > COST_CACHE_MAX_ENTRIES) {
    const oldest = costCache.keys().next().value;
    if (oldest !== undefined) costCache.delete(oldest);
  }
  return result;
}


// ---------------------------------------------------------------------------
// get_node_metrics
// ---------------------------------------------------------------------------

async function getNodeMetrics(): Promise<NodeMetricsInfo[]> {
  const [usage, nodes] = await Promise.all([nodeUsage(), getNodeInfo().catch(() => [] as NodeInfo[])]);
  const capacity = new Map(nodes.map((n) => [n.name, [n.cpu_capacity, n.memory_capacity_bytes] as const]));
  return [...usage.entries()].map(([name, u]) => {
    const [cpuCap, memCap] = capacity.get(name) ?? [0, 0];
    const cpuPct = cpuCap > 0 ? Math.min((u.cpu / cpuCap) * 100.0, 100.0) : 0;
    const memPct = memCap > 0 ? Math.min((u.memory / memCap) * 100.0, 100.0) : 0;
    return {
      node_name: name,
      cpu_usage: u.cpu,
      cpu_capacity: cpuCap,
      cpu_percent: Math.round(cpuPct * 10.0) / 10.0,
      memory_usage: u.memory,
      memory_capacity: memCap,
      memory_percent: Math.round(memPct * 10.0) / 10.0,
    };
  });
}

// ---------------------------------------------------------------------------
// Node costs
// ---------------------------------------------------------------------------

async function getNodeCosts(): Promise<NodeCostInfo[]> {
  const nodes = await getNodeInfo().catch(() => [] as NodeInfo[]);
  const pricing = (await resolvePricing(nodes)) ?? new Map<string, number>();

  return nodes.map((node) => {
    const key = `${node.provider}/${node.region}/${node.instance_type}`;
    const pricePerHour = pricing.get(key) ?? 0;
    return {
      node_name: node.name,
      instance_type: node.instance_type,
      provider: node.provider,
      region: node.region,
      price_per_hour: pricePerHour,
      price_per_month: pricePerHour * HOURS_PER_MONTH,
    };
  });
}


// ---------------------------------------------------------------------------
// refresh_pricing
// ---------------------------------------------------------------------------

function refreshPricing(): void {
  // Force-clear the in-memory pricing cache and the cost overview cache. Disk
  // state is left in place — the next call refetches conditionally (cheap 304).
  clearPricingCache();
  costCache.clear();
}

export { startPeriodicRefresh } from '../k8s/pricing.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  // Cluster-scoped caches must not survive a kubeconfig/context switch.
  onConfigChange(() => costCache.clear());

  handlers.set('get_cost_overview', async (args) => {
    const namespace =
      typeof args['namespace'] === 'string'
        ? (args['namespace'] as string)
        : args['namespace'] === null
          ? null
          : undefined;
    return getCostOverview(namespace);
  });

  handlers.set('get_node_costs', async () => getNodeCosts());

  handlers.set('get_node_metrics', async () => getNodeMetrics());

  handlers.set('refresh_pricing', async () => {
    refreshPricing();
    // The renderer ignores the value.
    return null;
  });
}
