// Raw authenticated requests against the active cluster's apiserver.
//
// The typed client-node Api classes cover most calls, but two things need the
// raw path: addressing arbitrary group/version/plural coordinates (the dynamic
// list used by every kind), and content negotiation for metadata-only lists.
// Both live here so handlers share one implementation of auth + TLS + headers.

import { kc, clusterAuthHeaders, expireClusterAuth } from './client';

/**
 * Metadata-only content negotiation: the apiserver returns a
 * PartialObjectMetadataList (just metadata, no spec/status/managedFields) for
 * any resource that supports it — a fraction of the full-body payload. Callers
 * that only need names, labels or counts should ask for it; the rare kind that
 * 406s falls back to a normal list.
 */
export const META_ACCEPT =
  'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json';

/**
 * Issue an authenticated GET against the active cluster, returning parsed JSON.
 *
 * Auth headers come from the shared per-cluster cache in client.ts (the same
 * one the typed clients use — one TTL, one single-flight, one invalidation);
 * TLS is handled by the undici dispatcher installed there. A 401 expires the
 * cache and retries once in case the token rotated inside the TTL window.
 */
export async function apiGet<T>(
  path: string,
  query?: Record<string, string>,
  accept?: string,
): Promise<T> {
  const cfg = kc();
  const cluster = cfg.getCurrentCluster();
  if (!cluster) {
    throw new Error('No active cluster in kubeconfig');
  }
  const url = new URL(cluster.server.replace(/\/$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...(await clusterAuthHeaders()) };
    if (accept) {
      // Content negotiation (e.g. PartialObjectMetadataList for counts) — far
      // smaller payloads, much faster to transfer + JSON.parse.
      headers.Accept = accept;
    }
    return fetch(url.toString(), { method: 'GET', headers });
  };

  let resp = await doFetch();
  if (resp.status === 401) {
    // Release the discarded body — unread, it pins the pooled connection.
    await resp.body?.cancel().catch(() => {});
    expireClusterAuth();
    resp = await doFetch();
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}${body ? `: ${body}` : ''}`);
  }
  return (await resp.json()) as T;
}

/**
 * Issue an authenticated GET and return the Response with its body UNCONSUMED,
 * so the caller can read it incrementally and abort it.
 *
 * Separate from apiGet, which buffers the whole body and JSON-parses it — the
 * opposite of what a `follow=true` log stream needs. Resolving as soon as the
 * response headers arrive also gives callers a truthful "connected" signal.
 *
 * The caller owns the returned body: it MUST read or cancel it, otherwise the
 * socket stays held open.
 */
export async function apiStream(
  path: string,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<Response> {
  const cfg = kc();
  const cluster = cfg.getCurrentCluster();
  if (!cluster) {
    throw new Error('No active cluster in kubeconfig');
  }
  const url = new URL(cluster.server.replace(/\/$/, '') + path);
  url.search = query.toString();

  const headers: Record<string, string> = { ...(await clusterAuthHeaders()) };
  const resp = await fetch(url.toString(), { method: 'GET', headers, signal });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}${body ? `: ${body}` : ''}`);
  }
  return resp;
}
