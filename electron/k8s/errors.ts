// Shared error helpers for the k8s handlers.

/**
 * Best-effort human message extracted from a @kubernetes/client-node error.
 * Prefers the apiserver-supplied body.message (a Status object), then the JS
 * Error message, then a stringified fallback. Mirrors the Rust handlers'
 * Result<_, String> messages.
 */
export function k8sErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { body?: { message?: string }; message?: string };
    if (e.body && typeof e.body.message === 'string' && e.body.message.length > 0) {
      return e.body.message;
    }
    if (typeof e.message === 'string' && e.message.length > 0) {
      return e.message;
    }
  }
  return String(err);
}
