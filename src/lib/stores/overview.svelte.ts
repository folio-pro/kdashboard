import { AsyncLoadStore } from "./async-load.svelte";
import type { ClusterOverview } from "$lib/types";

/**
 * One payload feeds two views (Overview, Problems). Loaded cluster-wide; the
 * backend narrows to the given namespace only where the cluster-wide list is
 * refused, and says so in `scope` / `partial`.
 */
class OverviewStore extends AsyncLoadStore<ClusterOverview> {
  get overview() { return this.data; }

  async loadOverview(namespace: string | null): Promise<void> {
    await this._load("get_cluster_overview", namespace);
  }
}

export const overviewStore = new OverviewStore();
