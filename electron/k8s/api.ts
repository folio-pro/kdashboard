// Raw authenticated requests against the active cluster's apiserver.
//
// The typed client-node Api classes cover most calls, but two things need the
// raw path: addressing arbitrary group/version/plural coordinates (the dynamic
// list used by every kind), and content negotiation for metadata-only lists.
// Both live here so handlers share one implementation of auth + TLS + headers.

import { kc } from './client';

/**
 * Metadata-only content negotiation: the apiserver returns a
 * PartialObjectMetadataList (just metadata, no spec/status/managedFields) for
 * any resource that supports it — a fraction of the full-body payload. Callers
 * that only need names, labels or counts should ask for it; the rare kind that
 * 406s falls back to a normal list.
 */
export const META_ACCEPT =
  'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json';

/** Issue an authenticated GET against the active cluster, returning parsed JSON. */
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

  // applyToFetchOptions injects auth headers + the TLS agent (client certs/CA).
  const opts = await cfg.applyToFetchOptions({});
  opts.method = 'GET';
  if (accept) {
    // Content negotiation (e.g. PartialObjectMetadataList for counts) — far
    // smaller payloads, much faster to transfer + JSON.parse.
    //
    // applyToFetchOptions hands back a Headers INSTANCE, whose entries live
    // behind a symbol key: spreading it produced `{[Symbol(map)]: …}`, which
    // fetch rejects ("Key Symbol(map) … cannot be converted to a ByteString").
    // Every counted request threw and get_resource_counts swallowed it as 0,
    // so the sidebar counts were silently always zero. Go through Headers.
    const merged: Record<string, string> = {};
    const existing: unknown = opts.headers;
    if (existing instanceof Headers) {
      existing.forEach((value, key) => {
        merged[key] = value;
      });
    } else if (existing && typeof existing === 'object') {
      for (const [key, value] of Object.entries(existing as Record<string, string>)) {
        merged[key] = String(value);
      }
    }
    merged.Accept = accept;
    opts.headers = merged;
  }

  const resp = await fetch(url.toString(), opts as RequestInit);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}${body ? `: ${body}` : ''}`);
  }
  return (await resp.json()) as T;
}
