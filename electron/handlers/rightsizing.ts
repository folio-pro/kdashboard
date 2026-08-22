// Rightsizing handler — requests vs observed usage per workload.
//
// Commands:
//   - get_rightsizing  { namespace?: string | null } -> RightsizingOverview
//
// Usage comes from Prometheus (P95 over 7 days, when Settings → Kubernetes
// points at one) or, failing that, from a metrics.k8s.io snapshot. Pods are
// listed cluster-wide with a per-namespace fallback. The arithmetic lives in
// electron/k8s/rightsizing.ts.

import { Metrics, type V1Pod } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api, kc } from '../k8s/client';
import { parseCpu, parseMemory } from '../k8s/quantity';
import {
  buildRightsizing,
  summarize,
  usageKey,
  type RightsizingOverview,
  type UsageSample,
} from '../k8s/rightsizing';
import { getPrometheusUrl } from '../k8s/runtime-config.js';
import { currentRates } from './cost';

const PROM_TIMEOUT_MS = 20_000;
const PROM_WINDOW = '7d';

interface PromVectorResponse {
  status?: string;
  error?: string;
  data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
}

async function promInstant(base: string, query: string): Promise<Array<{ metric: Record<string, string>; value: number }>> {
  const url = new URL(`${base}/api/v1/query`);
  url.searchParams.set('query', query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROM_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) throw new Error(`Prometheus returned ${resp.status}`);
    const body = (await resp.json()) as PromVectorResponse;
    if (body.status !== 'success') throw new Error(body.error ?? 'query failed');
    return (body.data?.result ?? []).map((r) => ({ metric: r.metric ?? {}, value: Number.parseFloat(r.value?.[1] ?? '0') || 0 }));
  } finally {
    clearTimeout(timer);
  }
}

/** P95 over the window of each container's CPU rate and working-set memory. */
async function usageFromPrometheus(base: string, namespace: string | null): Promise<Map<string, UsageSample>> {
  const sel = `container!="",container!="POD"${namespace ? `,namespace="${namespace}"` : ''}`;
  const [cpu, mem] = await Promise.all([
    promInstant(base, `quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{${sel}}[5m])[${PROM_WINDOW}:5m])`),
    promInstant(base, `quantile_over_time(0.95, container_memory_working_set_bytes{${sel}}[${PROM_WINDOW}:5m])`),
  ]);
  const map = new Map<string, UsageSample>();
  const get = (m: Record<string, string>) => {
    const key = usageKey(m.namespace ?? '', m.pod ?? '', m.container ?? '');
    let s = map.get(key);
    if (!s) {
      s = { namespace: m.namespace ?? '', pod: m.pod ?? '', container: m.container ?? '', cpu: null, memory: null };
      map.set(key, s);
    }
    return s;
  };
  for (const r of cpu) get(r.metric).cpu = r.value;
  for (const r of mem) get(r.metric).memory = r.value;
  return map;
}

async function usageFromMetricsServer(namespace: string | null): Promise<Map<string, UsageSample>> {
  const metrics = new Metrics(kc());
  let list;
  try {
    list = await metrics.getPodMetrics();
  } catch (err) {
    if (!namespace) throw err;
    list = await metrics.getPodMetrics(namespace);
  }
  const map = new Map<string, UsageSample>();
  for (const pm of list.items) {
    for (const c of pm.containers) {
      map.set(usageKey(pm.metadata.namespace, pm.metadata.name, c.name), {
        namespace: pm.metadata.namespace,
        pod: pm.metadata.name,
        container: c.name,
        cpu: parseCpu(c.usage.cpu),
        memory: parseMemory(c.usage.memory),
      });
    }
  }
  return map;
}

export async function getRightsizing(namespace: string | null): Promise<RightsizingOverview> {
  const core = getCoreV1Api();
  let pods: V1Pod[];
  let scope: RightsizingOverview['scope'] = 'cluster';
  try {
    pods = (await core.listPodForAllNamespaces()).items;
  } catch (err) {
    if (!namespace) throw err;
    pods = (await core.listNamespacedPod({ namespace })).items;
    scope = 'namespace';
  }

  let usage = new Map<string, UsageSample>();
  let source = 'none';
  let window = '';
  const prom = getPrometheusUrl();
  if (prom) {
    try {
      usage = await usageFromPrometheus(prom, scope === 'namespace' ? namespace : null);
      source = 'prometheus-p95-7d';
      window = '7d P95';
    } catch {
      usage = new Map();
    }
  }
  if (usage.size === 0) {
    try {
      usage = await usageFromMetricsServer(scope === 'namespace' ? namespace : null);
      source = 'metrics-server';
      window = 'now';
    } catch {
      usage = new Map();
      source = 'none';
    }
  }

  const rates = await currentRates();
  const workloads = buildRightsizing(pods, usage, { cpu: rates.cpu, memory: rates.memory });
  return {
    scope,
    namespace: scope === 'namespace' ? namespace : null,
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
  handlers.set('get_rightsizing', async (args) => {
    const ns = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : null;
    return getRightsizing(ns);
  });
}
