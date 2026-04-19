import { AsyncLoadStore } from "./async-load.svelte";
import type { SecurityOverview } from "$lib/types";

class SecurityStore extends AsyncLoadStore<SecurityOverview> {
  /** Alias for readability in templates */
  get overview() { return this.data; }

  async loadSecurityOverview(namespace: string | null): Promise<void> {
    await this._load("get_security_overview", namespace);
  }
}

export const securityStore = new SecurityStore();
