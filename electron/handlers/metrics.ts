// Handler module: metrics
//
// Commands:
//   get_pod_metrics        -> instantaneous CPU/memory per pod (metrics.k8s.io)
//   query_prometheus_range -> a range query against the configured Prometheus,
//                             for the sparklines the Metrics API cannot provide
//
// metrics.k8s.io only ever reports the LAST scrape, so the tables show "right
// now" and history comes from Prometheus when the user configures one. Both
// paths are optional: a cluster with no metrics-server returns an empty list
// with `available: false` rather than an error, so the table just hides the
// columns instead of showing a failure the user cannot act on.

import { Metrics, type PodMetric } from '@kubernetes/client-node';

import { kc } from '../k8s/client.js';
import { parseCpu, parseMemory } from '../k8s/quantity.js';
import { getPrometheusUrl } from '../k8s/runtime-config.js';
import type { HandlerMap } from '../dispatch.js';

// ---------------------------------------------------------------------------
// Wire shapes (snake_case, matching the rest of the IPC surface — the renderer
// mirror lives in src/lib/types/metrics.ts)
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

export interface PodMetricsResult {
  /** False when the cluster has no metrics-server (or it is not reachable). */
  available: boolean;
  /** Why metrics are unavailable, for the UI tooltip. Empty when available. */
  reason: string;
  pods: PodUsageInfo[];
}

export interface PrometheusSample {
  /** Unix seconds. */
  t: number;
  v: number;
}

export interface PrometheusSeries {
  labels: Record<string, string>;
  samples: PrometheusSample[];
}

export interface PrometheusResult {
  configured: boolean;
  series: PrometheusSeries[];
}

// ---------------------------------------------------------------------------
// metrics.k8s.io
// ---------------------------------------------------------------------------

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string' || v === '' || v === 'All Namespaces') return undefined;
  return v;
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

async function getPodMetrics(args: Record<string, unknown>): Promise<PodMetricsResult> {
  const namespace = optStr(args, 'namespace');
  try {
    const response = await new Metrics(kc()).getPodMetrics(namespace);
    return { available: true, reason: '', pods: response.items.map(podUsageFrom) };
  } catch (err) {
    // A missing metrics-server is the common case here, not an error worth
    // surfacing as a failed command — the UI degrades to no usage columns.
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      pods: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Prometheus (optional, configured in Settings -> Kubernetes)
// ---------------------------------------------------------------------------

const PROM_TIMEOUT_MS = 15_000;

interface PromMatrixResult {
  metric?: Record<string, string>;
  values?: Array<[number, string]>;
}

interface PromResponse {
  status?: string;
  error?: string;
  data?: { resultType?: string; result?: PromMatrixResult[] };
}

/**
 * Run a Prometheus range query. `minutes` back from now, with the step chosen
 * so a series stays around 60 points whatever the window.
 */
async function queryPrometheusRange(args: Record<string, unknown>): Promise<PrometheusResult> {
  const base = getPrometheusUrl();
  if (base === undefined) return { configured: false, series: [] };

  const query = args.query;
  if (typeof query !== 'string' || query === '') {
    throw new Error("Missing or invalid 'query' argument");
  }
  const minutes = typeof args.minutes === 'number' && args.minutes > 0 ? args.minutes : 60;

  const end = Math.floor(Date.now() / 1000);
  const start = end - minutes * 60;
  const step = Math.max(15, Math.round((minutes * 60) / 60));

  const url = new URL(`${base}/api/v1/query_range`);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', String(step));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROM_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Prometheus returned ${resp.status} ${resp.statusText}`);
    }
    const body = (await resp.json()) as PromResponse;
    if (body.status !== 'success') {
      throw new Error(body.error ?? 'Prometheus query failed');
    }
    return { configured: true, series: seriesFrom(body) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Prometheus query timed out after ${PROM_TIMEOUT_MS / 1000}s`);
    }
    // Name the target explicitly: the generic invoke error handler assumes any
    // failed fetch was the apiserver, which sends people debugging the wrong
    // endpoint when it was really an unreachable Prometheus.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Prometheus request to ${base} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Map a Prometheus matrix response to the renderer's series shape. */
export function seriesFrom(body: PromResponse): PrometheusSeries[] {
  return (body.data?.result ?? []).map((r) => ({
    labels: r.metric ?? {},
    samples: (r.values ?? []).map(([t, v]) => ({ t, v: Number.parseFloat(v) || 0 })),
  }));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(handlers: HandlerMap): void {
  handlers.set('get_pod_metrics', async (args) => getPodMetrics(args));
  handlers.set('query_prometheus_range', async (args) => queryPrometheusRange(args));
}
