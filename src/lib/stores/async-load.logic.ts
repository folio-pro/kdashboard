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

  reset(): void {
    this._loadId++;
    this.data = null;
    this.isLoading = false;
    this.error = null;
    this._dataScope = null;
  }
}
