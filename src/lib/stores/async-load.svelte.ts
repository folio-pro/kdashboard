import { invoke } from "@tauri-apps/api/core";
import { AsyncLoadStoreLogic } from "./async-load.logic";
import { unshadowState } from "./_unshadow.js";

/**
 * Base class for stores that load data from a Tauri command with
 * namespace filtering, loading/error state, and stale request detection.
 *
 * Usage:
 *   class CostStore extends AsyncLoadStore<CostOverview> { ... }
 */
export class AsyncLoadStore<T> extends AsyncLoadStoreLogic<T> {
  override data = $state<T | null>(null);
  override isLoading = $state(false);
  override error = $state<string | null>(null);

  constructor() {
    super();
    unshadowState(this);
  }

  /**
   * Load data from a Tauri command with automatic namespace normalization,
   * loading state management, and stale response detection.
   */
  protected async _load(command: string, namespace: string | null): Promise<void> {
    const loadId = ++this._loadId;
    this.isLoading = true;
    this.error = null;

    try {
      const ns = namespace && namespace !== "All Namespaces" ? namespace : null;
      const result = await invoke<T>(command, { namespace: ns });
      if (loadId !== this._loadId) return;
      this.data = result;
    } catch (err) {
      if (loadId !== this._loadId) return;
      this.error = String(err);
      this.data = null;
    } finally {
      if (loadId === this._loadId) this.isLoading = false;
    }
  }
}
