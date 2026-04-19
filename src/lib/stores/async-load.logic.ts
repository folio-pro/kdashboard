/**
 * Base class for stores that load data from a Tauri command with
 * namespace filtering, loading/error state, and stale request detection.
 *
 * Pure logic version (no Svelte runes) for testing.
 */
export class AsyncLoadStoreLogic<T> {
  data: T | null = null;
  isLoading = false;
  error: string | null = null;
  protected _loadId = 0;

  reset(): void {
    this._loadId++;
    this.data = null;
    this.isLoading = false;
    this.error = null;
  }
}
