import { AsyncLoadStore } from "./async-load.svelte";
import type { SecurityOverview } from "$lib/types";
import { onContextChange } from "./cluster-scope.logic";

class SecurityStore extends AsyncLoadStore<SecurityOverview> {
  /** Alias for readability in templates */
  get overview() { return this.data; }

  async loadSecurityOverview(namespace: string | null): Promise<void> {
    await this._load("get_security_overview", namespace);
  }
}

export const securityStore = new SecurityStore();

// One cluster's data: a context switch must not leave it on screen.
onContextChange("security", () => securityStore.reset());
