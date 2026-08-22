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

import { onConfigChange } from '../k8s/client.js';
import { podUsage, podUsageFrom, type ContainerUsage, type PodUsageInfo } from '../k8s/metrics-source.js';
import { promQuery } from '../k8s/prometheus.js';
import { getPrometheusUrl } from '../k8s/runtime-config.js';
import { optStr, type HandlerMap } from '../dispatch.js';

export { podUsageFrom, type ContainerUsage, type PodUsageInfo };

// ---------------------------------------------------------------------------
// Wire shapes (snake_case, matching the rest of the IPC surface — the renderer
// mirror lives in src/lib/types/metrics.ts)
// ---------------------------------------------------------------------------

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

/**
 * Short-lived coalescing cache: two views (pods table + usage card) can ask
 * for the same namespace's metrics in the same window; metrics-server only
 * rescrapes every ~60s, so serving the same promise for a few seconds dedupes
 * the request without visible staleness. Cleared on context switch.
 */
const POD_METRICS_COALESCE_MS = 5_000;
const podMetricsCache = new Map<string, { at: number; promise: Promise<PodMetricsResult> }>();
onConfigChange(() => podMetricsCache.clear());

async function getPodMetrics(args: Record<string, unknown>): Promise<PodMetricsResult> {
  const namespace = optStr(args, 'namespace');
  const key = namespace ?? '';
  const now = Date.now();
  const hit = podMetricsCache.get(key);
  if (hit && now - hit.at < POD_METRICS_COALESCE_MS) return hit.promise;
  const promise = fetchPodMetrics(namespace);
  podMetricsCache.set(key, { at: now, promise });
  return promise;
}

async function fetchPodMetrics(namespace: string | undefined): Promise<PodMetricsResult> {
  try {
    return { available: true, reason: '', pods: await podUsage(namespace) };
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

/**
 * Run a Prometheus range query. `minutes` back from now, with the step chosen
 * so a series stays around 60 points whatever the window.
 */
async function queryPrometheusRange(args: Record<string, unknown>): Promise<PrometheusResult> {
  if (getPrometheusUrl() === undefined) return { configured: false, series: [] };

  const query = args.query;
  if (typeof query !== 'string' || query === '') {
    throw new Error("Missing or invalid 'query' argument");
  }
  const minutes = typeof args.minutes === 'number' && args.minutes > 0 ? args.minutes : 60;
  const end = Math.floor(Date.now() / 1000);
  const start = end - minutes * 60;
  const step = Math.max(15, Math.round((minutes * 60) / 60));
  const result = await promQuery<PromMatrixResult>('query_range', { query, start: String(start), end: String(end), step: String(step) });
  return { configured: true, series: seriesFrom(result) };
}

/** Map a Prometheus matrix result to the renderer's series shape. */
export function seriesFrom(result: PromMatrixResult[]): PrometheusSeries[] {
  return result.map((r) => ({
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
