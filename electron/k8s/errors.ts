// Shared error helpers for the k8s handlers.

import { STATUS_CODES } from 'node:http';

import { getApiserverOrigin } from './client.js';

/**
 * Human hints for low-level network/TLS error codes. undici's fetch throws a
 * bare `TypeError: fetch failed` with the real failure buried in `cause` (and
 * for multi-address hosts, inside an AggregateError) — without unwrapping, the
 * renderer shows "fetch failed" and nothing else.
 */
const NETWORK_HINTS: Record<string, string> = {
  ECONNREFUSED: 'connection refused — nothing is listening there (cluster down, VPN/tunnel not up, or wrong port in kubeconfig)',
  ENOTFOUND: 'DNS lookup failed — the hostname does not resolve (VPN/DNS down, or stale kubeconfig)',
  EAI_AGAIN: 'DNS lookup timed out — check your network or VPN',
  ETIMEDOUT: 'connection timed out — host unreachable (firewall, VPN, or cluster down)',
  EHOSTUNREACH: 'host unreachable — no network route (VPN or network down)',
  ENETUNREACH: 'network unreachable — check your network connection',
  ECONNRESET: 'connection reset by the server or an intermediate proxy',
  EPIPE: 'connection closed while sending the request',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out — host unreachable (firewall, VPN, or cluster down)',
  UND_ERR_HEADERS_TIMEOUT: 'the server accepted the connection but never responded (hung apiserver or proxy)',
  UND_ERR_SOCKET: 'connection closed unexpectedly',
  CERT_HAS_EXPIRED: 'the cluster TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the cluster presents a self-signed certificate not trusted by the kubeconfig CA',
  SELF_SIGNED_CERT_IN_CHAIN: 'the cluster certificate chain contains a self-signed certificate not trusted by the kubeconfig CA',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the cluster TLS certificate cannot be verified with the kubeconfig CA',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the cluster TLS certificate issuer is not trusted by the kubeconfig CA',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the cluster TLS certificate does not match the apiserver hostname',
};

/** Walk err -> cause -> AggregateError.errors collecting the first known code. */
function findNetworkCode(err: unknown, depth = 0): string | null {
  if (!err || typeof err !== 'object' || depth > 6) return null;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof e.code === 'string' && e.code in NETWORK_HINTS) return e.code;
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const code = findNetworkCode(inner, depth + 1);
      if (code) return code;
    }
  }
  return findNetworkCode(e.cause, depth + 1);
}

/** Deepest non-empty message in the cause chain (fallback when no code matched). */
function deepestMessage(err: unknown, depth = 0): string | null {
  if (!err || typeof err !== 'object' || depth > 6) return null;
  const e = err as { message?: unknown; cause?: unknown };
  const below = deepestMessage(e.cause, depth + 1);
  if (below) return below;
  return typeof e.message === 'string' && e.message.length > 0 ? e.message : null;
}

/**
 * Turn a handler failure into a message the user can act on. Network/TLS
 * failures become "Cannot reach the cluster apiserver at <origin>: <hint>";
 * anything else keeps its original (apiserver-provided when available) message.
 */
export function describeInvokeError(err: unknown): string {
  const code = findNetworkCode(err);
  if (code) {
    const target = getApiserverOrigin() ?? 'the cluster apiserver';
    const at = target.startsWith('http') ? `the cluster apiserver at ${target}` : target;
    return `Cannot reach ${at}: ${NETWORK_HINTS[code]} [${code}]`;
  }
  const message = k8sErrorMessage(err);
  // undici's bare "fetch failed" carries no information — surface the cause.
  if (/fetch failed/i.test(message)) {
    const cause = deepestMessage((err as { cause?: unknown })?.cause);
    const target = getApiserverOrigin();
    return `Request to ${target ?? 'the cluster apiserver'} failed${cause ? `: ${cause}` : ''}`;
  }
  return message;
}

/**
 * HTTP status of a @kubernetes/client-node error, when it carries one.
 * ApiException sets a numeric `code`; network errors carry a string `code`
 * (ECONNREFUSED…), which is ignored. Match on this, not on message text.
 */
export function k8sStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; statusCode?: unknown };
  if (typeof e.code === 'number') return e.code;
  return typeof e.statusCode === 'number' ? e.statusCode : undefined;
}

/**
 * The apiserver Status.message carried in an error body. client-node 1.4's
 * ApiException holds the raw response text, so a string body is parsed; an
 * already-parsed object is accepted too.
 */
function statusMessage(body: unknown): string | null {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null; // not JSON (e.g. an HTML page from a proxy)
    }
  }
  const message = (parsed as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/**
 * Best-effort human message extracted from a @kubernetes/client-node error.
 * Prefers the apiserver-supplied Status.message, then "<code> <reason>" for an
 * HTTP error without one — never ApiException's own message, which dumps the
 * raw body and every response header — then the JS Error message, then a
 * stringified fallback.
 */
export function k8sErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { body?: unknown; message?: unknown };
    const fromBody = statusMessage(e.body);
    if (fromBody) return fromBody;
    const code = k8sStatusCode(err);
    if (code !== undefined) {
      const reason = STATUS_CODES[code];
      return reason ? `${code} ${reason}` : `HTTP ${code}`;
    }
    if (typeof e.message === 'string' && e.message.length > 0) {
      return e.message;
    }
  }
  return String(err);
}
