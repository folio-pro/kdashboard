// The one HTTP path to the optional Prometheus (Settings → Kubernetes).
// Handlers build the query; this owns the URL, timeout, status check and
// the error wording that names the target.

import { getPrometheusUrl } from './runtime-config.js';

export const PROM_TIMEOUT_MS = 15_000;

export interface PromResponse<R> {
  status?: string;
  error?: string;
  data?: { resultType?: string; result?: R[] };
}

/**
 * GET `${base}/api/v1/${path}` with `params`. Returns the parsed body's
 * `data.result` (empty when absent); throws on an unreachable or unhappy
 * Prometheus, or when none is configured (callers check
 * `getPrometheusUrl()` first when "not configured" is not an error).
 */
export async function promQuery<R>(
  path: 'query' | 'query_range',
  params: Record<string, string>,
  timeoutMs = PROM_TIMEOUT_MS,
): Promise<R[]> {
  const base = getPrometheusUrl();
  if (base === undefined) throw new Error('No Prometheus URL configured');
  const url = new URL(`${base}/api/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) throw new Error(`Prometheus returned ${resp.status} ${resp.statusText}`);
    const body = (await resp.json()) as PromResponse<R>;
    if (body.status !== 'success') throw new Error(body.error ?? 'Prometheus query failed');
    return body.data?.result ?? [];
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Prometheus query timed out after ${timeoutMs / 1000}s`);
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
