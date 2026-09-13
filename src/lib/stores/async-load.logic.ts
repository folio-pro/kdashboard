/**
 * Base class for stores that load data from a backend command with
 * namespace filtering, loading/error state, and stale request detection.
 *
 * Pure logic version (no Svelte runes) for testing.
 */
export class AsyncLoadStoreLogic<T> {
  data: T | null = null;
  isLoading = false;
  error: string | null = null;
  protected _loadId = 0;
  /** The normalized namespace `data` was loaded for (null = all namespaces). */
  protected _dataScope: string | null = null;

  /** Normalize a namespace selection to the key `data` is tagged with. */
  protected _scopeOf(namespace: string | null): string | null {
    return namespace && namespace !== "All Namespaces" ? namespace : null;
  }

  /**
   * Adopt `ns` as the scope of the load about to run. A scope change must not
   * keep the previous namespace's payload on screen under the new label; a
   * same-scope refresh keeps it (stale-while-revalidate). Subclasses with a
   * hand-rolled loader (topology's focused-resource path) have to call this
   * too, or they silently opt out of the rule.
   */
  protected _enterScope(ns: string | null): void {
    if (this._dataScope === ns) return;
    this.data = null;
    this._dataScope = ns;
  }

  reset(): void {
    this._loadId++;
    this.data = null;
    this.isLoading = false;
    this.error = null;
    this._dataScope = null;
  }
}
