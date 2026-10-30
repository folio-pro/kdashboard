/**
 * The "did the header's namespace picker change scope?" decision behind
 * ViewPanel's `onNamespaceChange`. The first namespace seen only primes the
 * tracker: openAppView already issued the entry load for it, so reporting it
 * as a change would load every view twice on open.
 */
export function namespaceChangeTracker(): (namespace: string) => boolean {
  let last: string | undefined;
  return (namespace) => {
    const changed = last !== undefined && last !== namespace;
    last = namespace;
    return changed;
  };
}
