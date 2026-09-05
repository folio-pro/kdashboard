// Rightsizing handler — requests vs observed usage per workload.
//
// Commands:
//   - get_rightsizing  { namespace?: string | null } -> RightsizingOverview
//
// Usage comes from Prometheus (P95 over 7 days, when Settings → Kubernetes
// points at one) or, failing that, from a metrics.k8s.io snapshot. Pods are
// listed cluster-wide with a per-namespace fallback. The arithmetic lives in
// electron/k8s/rightsizing.ts.

import type { V1Pod } from '@kubernetes/client-node';

import { optStr, type HandlerCtx, type HandlerMap } from '../dispatch';
import { getCoreV1Api } from '../k8s/client';
import { listScoped } from '../k8s/list-scope';
import { podUsageScoped } from '../k8s/metrics-source';
import { currentRates } from '../k8s/pricing';
import { promQuery } from '../k8s/prometheus';
import {
  buildRightsizing,
  summarize,
  usageKey,
  type RightsizingOverview,
  type UsageSample,
} from '../k8s/rightsizing';
import { getPrometheusUrl } from '../k8s/runtime-config.js';

const PROM_WINDOW = '7d';

interface PromVector {
  metric?: Record<string, string>;
  value?: [number, string];
}

function vectorToMap(rows: PromVector[], into: Map<string, UsageSample>, set: (s: UsageSample, v: number) => void): void {
  for (const r of rows) {
    const m = r.metric ?? {};
    const key = usageKey(m.namespace ?? '', m.pod ?? '', m.container ?? '');
    let s = into.get(key);
    if (!s) {
      s = { namespace: m.namespace ?? '', pod: m.pod ?? '', container: m.container ?? '', cpu: null, memory: null };
      into.set(key, s);
    }
    set(s, Number.parseFloat(r.value?.[1] ?? '0') || 0);
  }
}

/** P95 over the window of each container's CPU rate and working-set memory. */
async function usageFromPrometheus(namespace: string | null): Promise<Map<string, UsageSample>> {
  const sel = `container!="",container!="POD"${namespace ? `,namespace="${namespace}"` : ''}`;
  const [cpu, mem] = await Promise.all([
    promQuery<PromVector>('query', { query: `quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{${sel}}[5m])[${PROM_WINDOW}:5m])` }, 20_000),
    promQuery<PromVector>('query', { query: `quantile_over_time(0.95, container_memory_working_set_bytes{${sel}}[${PROM_WINDOW}:5m])` }, 20_000),
  ]);
  const map = new Map<string, UsageSample>();
  vectorToMap(cpu, map, (s, v) => { s.cpu = v; });
  vectorToMap(mem, map, (s, v) => { s.memory = v; });
  return map;
}

async function usageFromMetricsServer(namespace: string | null): Promise<Map<string, UsageSample>> {
  const map = new Map<string, UsageSample>();
  for (const p of await podUsageScoped(namespace)) {
    for (const c of p.containers) {
      map.set(usageKey(p.namespace, p.name, c.name), { namespace: p.namespace, pod: p.name, container: c.name, cpu: c.cpu_cores, memory: c.memory_bytes });
    }
  }
  return map;
}

export async function getRightsizing(namespace: string | null): Promise<RightsizingOverview> {
  const core = getCoreV1Api();
  const [pods, rates] = await Promise.all([
    listScoped<V1Pod>(() => core.listPodForAllNamespaces(), (ns) => core.listNamespacedPod({ namespace: ns }), namespace),
    currentRates(),
  ]);
  if (pods.scope === null) throw new Error('Cannot list pods in this cluster or namespace');
  const scopeNs = pods.scope === 'namespace' ? namespace : null;

  let usage = new Map<string, UsageSample>();
  let source = 'none';
  let window = '';
  if (getPrometheusUrl()) {
    try {
      usage = await usageFromPrometheus(scopeNs);
      source = 'prometheus-p95-7d';
      window = '7d P95';
    } catch {
      usage = new Map();
    }
  }
  if (usage.size === 0) {
    try {
      usage = await usageFromMetricsServer(scopeNs);
      source = 'metrics-server';
      window = 'now';
    } catch {
      usage = new Map();
      source = 'none';
    }
  }

  const workloads = buildRightsizing(pods.items, usage, { cpu: rates.cpu, memory: rates.memory });
  return {
    scope: pods.scope,
    namespace: scopeNs,
    workloads,
    usage_source: source,
    usage_window: window,
    cpu_rate_per_core_hour: rates.cpu,
    memory_rate_per_gb_hour: rates.memory,
    ...summarize(workloads),
    fetched_at: new Date().toISOString(),
  };
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_rightsizing', async (args) => getRightsizing(optStr(args, 'namespace') ?? null));
}
