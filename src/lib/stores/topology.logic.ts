import { AsyncLoadStoreLogic } from "./async-load.logic";
import type { TopologyGraph } from "$lib/types";

export class TopologyStoreLogic extends AsyncLoadStoreLogic<TopologyGraph> {
  /** Alias for readability in templates */
  get graph() { return this.data; }

  selectedNodeId: string | null = null;
  expandedClusters: Set<string> = new Set();
  focusedResourceUid: string | null = null;

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
