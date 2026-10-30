// The Node detail's "Pods on this node" card: the list_resources call that
// asks the apiserver for only that node's pods, and the order the card shows
// them in. Pure: runs under bun with no Svelte runtime.

import type { Resource } from "$lib/types";

/** list_resources args for every pod scheduled on `node`, across namespaces. */
export function nodePodsListArgs(node: string): {
  resourceType: "pods";
  namespace: null;
  fieldSelector: string;
} {
  return { resourceType: "pods", namespace: null, fieldSelector: `spec.nodeName=${node}` };
}

/**
 * The node's pods sorted by namespace, then name. The field selector already
 * filtered server-side; the nodeName check stays as a safety net.
 */
export function podsOnNode(items: Resource[], node: string): Resource[] {
  return items
    .filter((p) => (p.spec?.nodeName as string | undefined) === node)
    .sort((a, b) =>
      (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") ||
      a.metadata.name.localeCompare(b.metadata.name),
    );
}
