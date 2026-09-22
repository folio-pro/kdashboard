import { AsyncLoadStore } from "./async-load.svelte";
import type { RightsizingOverview } from "$lib/types";
import { onContextChange } from "./cluster-scope.logic";

class RightsizingStore extends AsyncLoadStore<RightsizingOverview> {
  get overview() { return this.data; }

  async loadRightsizing(namespace: string | null): Promise<void> {
    await this._load("get_rightsizing", namespace);
  }
}

export const rightsizingStore = new RightsizingStore();

// One cluster's data: a context switch must not leave it on screen.
onContextChange("rightsizing", () => rightsizingStore.reset());
