import { invoke } from "@tauri-apps/api/core";
import { AsyncLoadStore } from "./async-load.svelte";
import { unshadowState } from "./_unshadow.js";
import type { TopologyGraph } from "$lib/types";

class TopologyStore extends AsyncLoadStore<TopologyGraph> {
  /** Alias for readability in templates */
  get graph() { return this.data; }

  selectedNodeId = $state<string | null>(null);
  expandedClusters = $state<Set<string>>(new Set());
  focusedResourceUid = $state<string | null>(null);

  constructor() {
    super();
    unshadowState(this);
  }

  async loadNamespaceTopology(namespace: string | null): Promise<void> {
    this.focusedResourceUid = null;
    this.selectedNodeId = null;
    this.expandedClusters = new Set();
    await this._load("get_namespace_topology", namespace);
  }

  async loadResourceTopology(uid: string, namespace: string | null): Promise<void> {
    const loadId = ++this._loadId;
    this.isLoading = true;
    this.error = null;
    this.focusedResourceUid = uid;
    this.selectedNodeId = uid;
    this.expandedClusters = new Set();

    try {
      const result = await invoke<TopologyGraph>("get_resource_topology", {
        uid,
        namespace: namespace || null,
      });
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

  selectNode(id: string | null): void {
    this.selectedNodeId = id;
  }

  toggleClusterExpansion(controllerId: string): void {
    const next = new Set(this.expandedClusters);
    if (next.has(controllerId)) {
      next.delete(controllerId);
    } else {
      next.add(controllerId);
    }
    this.expandedClusters = next;
  }

  override reset(): void {
    super.reset();
    this.selectedNodeId = null;
    this.expandedClusters = new Set();
    this.focusedResourceUid = null;
  }
}

export const topologyStore = new TopologyStore();
