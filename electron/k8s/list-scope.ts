// "List cluster-wide, else in the namespace" — the shape every cluster-level
// view needs under namespace-scoped RBAC, written once.

export interface Listed<T> {
  items: T[];
  /** 'cluster' | 'namespace' | null when the list failed entirely. */
  scope: 'cluster' | 'namespace' | null;
}

/**
 * Try the cluster-wide list; on failure (RBAC, usually) retry in `namespace`
 * when one is given. Never throws — a failed kind is reported as `scope: null`.
 */
export async function listScoped<T>(
  clusterWide: () => Promise<{ items: T[] }>,
  namespaced: ((ns: string) => Promise<{ items: T[] }>) | null,
  namespace: string | null,
): Promise<Listed<T>> {
  try {
    const { items } = await clusterWide();
    return { items, scope: 'cluster' };
  } catch {
    if (!namespace || !namespaced) return { items: [], scope: null };
    try {
      const { items } = await namespaced(namespace);
      return { items, scope: 'namespace' };
    } catch {
      return { items: [], scope: null };
    }
  }
}
