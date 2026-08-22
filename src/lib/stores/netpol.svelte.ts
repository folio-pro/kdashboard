import { AsyncLoadStore } from "./async-load.svelte";
import type { NetworkPolicyOverview } from "$lib/types";

class NetpolStore extends AsyncLoadStore<NetworkPolicyOverview> {
  get overview() { return this.data; }

  async loadNetworkPolicies(namespace: string): Promise<void> {
    await this._load("get_network_policies", namespace);
  }
}

export const netpolStore = new NetpolStore();
