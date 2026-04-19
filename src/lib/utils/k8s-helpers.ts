/**
 * Get human-readable state string from a K8s container state object.
 */
export function getContainerState(state: Record<string, unknown>): string {
  if (state.running) return "Running";
  if (state.waiting) return (state.waiting as { reason?: string }).reason ?? "Waiting";
  if (state.terminated) return (state.terminated as { reason?: string }).reason ?? "Terminated";
  return "Unknown";
}

/**
 * Toggle a key in an immutable Set (for Svelte 5 $state reactivity).
 */
export function toggleSetItem(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Resolve a simplified JSON path (e.g., ".status.phase") against a K8s Resource.
 * Handles .status.*, .spec.*, and .metadata.{name,namespace} paths.
 */
export function resolveJsonPath(
  resource: { metadata: { name?: string; namespace?: string }; status?: Record<string, unknown>; spec?: Record<string, unknown> },
  path: string,
): string {
  const parts = path.replace(/^\./, "").split(".");
  if (parts.length === 0) return "";

  if (parts[0] === "metadata") {
    const field = parts[1];
    if (field === "name") return resource.metadata.name ?? "";
    if (field === "namespace") return resource.metadata.namespace ?? "";
    return "";
  }

  let root: Record<string, unknown> | undefined;
  if (parts[0] === "status") root = resource.status;
  else if (parts[0] === "spec") root = resource.spec;
  if (!root) return "";

  let current: unknown = root;
  for (const part of parts.slice(1)) {
    if (current == null || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[part];
  }

  if (current == null) return "";
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  return JSON.stringify(current);
}
