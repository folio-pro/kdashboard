import { AsyncLoadStore } from "./async-load.svelte";
import type { NetworkPolicyOverview } from "$lib/types";
import { onContextChange } from "./cluster-scope.logic";

class NetpolStore extends AsyncLoadStore<NetworkPolicyOverview> {
  get overview() { return this.data; }

  async loadNetworkPolicies(namespace: string): Promise<void> {
    await this._load("get_network_policies", namespace);
  }
}

export const netpolStore = new NetpolStore();

// One cluster's data: a context switch must not leave it on screen.
onContextChange("netpol", () => netpolStore.reset());
