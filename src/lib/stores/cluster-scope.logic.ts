/**
 * Stores that hold one cluster's data register a reset here, and
 * switchContext() runs them all before connecting to the new context — the
 * renderer-side twin of the backend's onConfigChange. Registering at the
 * store's definition (rather than listing stores in switchContext) means a
 * new cluster-scoped store can't be forgotten by the one place that resets.
 */
export class ClusterScopeRegistry {
  // Keyed by name so a module re-evaluated under HMR replaces its reset
  // instead of piling up a second one against a dead singleton.
  private readonly resets = new Map<string, () => void>();

  /** Register `reset` under `name`. Returns an unregister function. */
  register(name: string, reset: () => void): () => void {
    this.resets.set(name, reset);
    return () => {
      if (this.resets.get(name) === reset) this.resets.delete(name);
    };
  }

  /**
   * Run every registered reset. One throwing must not leave the stores after
   * it holding the previous cluster's data, so failures are reported and the
   * loop carries on.
   */
  resetAll(onError: (name: string, err: unknown) => void = defaultOnError): void {
    for (const [name, reset] of this.resets) {
      try {
        reset();
      } catch (err) {
        onError(name, err);
      }
    }
  }

  get names(): string[] {
    return [...this.resets.keys()];
  }
}

function defaultOnError(name: string, err: unknown): void {
  console.error(`[cluster-scope] resetting "${name}" failed:`, err);
}

export const clusterScope = new ClusterScopeRegistry();

/** Run `reset` whenever the kube context changes (before the new one connects). */
export function onContextChange(name: string, reset: () => void): () => void {
  return clusterScope.register(name, reset);
}
