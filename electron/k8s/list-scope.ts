// "List cluster-wide, else in the namespace" — the shape every cluster-level
// view needs under namespace-scoped RBAC, written once.

export interface Listed<T> {
  items: T[];
  /** 'cluster' | 'namespace' | null when the list failed entirely. */
  scope: 'cluster' | 'namespace' | null;
}

/**
 * With a namespace and a namespaced lister, list in that namespace — the user
 * asked for it, so the result must be scoped to it (the Overview picker used
 * to say "default" while every list ran cluster-wide). Without a namespace,
 * list cluster-wide. Never throws — a failed kind is reported as `scope: null`.
 */
export async function listScoped<T>(
  clusterWide: () => Promise<{ items: T[] }>,
  namespaced: ((ns: string) => Promise<{ items: T[] }>) | null,
  namespace: string | null,
): Promise<Listed<T>> {
  if (namespace && namespaced) {
    try {
      const { items } = await namespaced(namespace);
      return { items, scope: 'namespace' };
    } catch {
      return { items: [], scope: null };
    }
  }
  try {
    const { items } = await clusterWide();
    return { items, scope: 'cluster' };
  } catch {
    return { items: [], scope: null };
  }
}
