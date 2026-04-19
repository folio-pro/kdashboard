import { AsyncLoadStoreLogic } from "./async-load.logic";
import type { SecurityOverview } from "$lib/types";

export class SecurityStoreLogic extends AsyncLoadStoreLogic<SecurityOverview> {
  /** Alias for readability in templates */
  get overview() { return this.data; }
}
