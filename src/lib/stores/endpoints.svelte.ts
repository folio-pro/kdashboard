import { invoke } from "$lib/ipc/core";
import type { Resource, ResourceList } from "$lib/types";
import { unshadowState } from "./_unshadow.js";
import { EndpointsStoreLogic, ENDPOINTS_TTL_MS } from "./endpoints.logic";

class EndpointsStore extends EndpointsStoreLogic {
  // $state.raw: rebuilt wholesale on every load; the slices are immutable snapshots.
  override byService = $state.raw<Record<string, Resource[]>>({});
  override loadedNamespace = $state<string | null | undefined>(undefined);

  constructor() {
    super();
    unshadowState(this);
  }

  /**
   * Load the EndpointSlices of a namespace ("" / null = all). Self-throttled
   * to ENDPOINTS_TTL_MS so the table's poll can call it freely.
   */
  async load(namespace: string | null, force = false): Promise<void> {
    const ns = namespace || null;
    if (this._loading && !force) return;
    if (!force && !this.isStale(Date.now(), ns)) return;
    this._loading = true;
    const requestId = ++this._requestId;
    try {
      const result = await invoke<ResourceList>("list_resources", { resourceType: "endpointslices", namespace: ns ?? "" });
      if (requestId !== this._requestId) return;
      this.apply(result.items, ns, Date.now());
    } catch {
      // No discovery API or no permission: the Endpoints cell stays blank.
    } finally {
      if (requestId === this._requestId) this._loading = false;
    }
  }

  override reset(): void {
    super.reset();
    this.byService = {};
    this.loadedNamespace = undefined;
  }
}

export const endpointsStore = new EndpointsStore();
export { ENDPOINTS_TTL_MS };
