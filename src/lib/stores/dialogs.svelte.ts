import type { Resource } from "$lib/types";
import { DialogStoreLogic } from "./dialogs.logic";
import { unshadowState } from "./_unshadow.js";

export type { ScaleResourceInfo } from "./dialogs.logic";

class DialogStore extends DialogStoreLogic {
  // Override plain properties with Svelte 5 reactive state
  scaleOpen = $state(false);
  scaleResource = $state<{ kind: string; name: string; namespace: string; currentReplicas: number } | null>(null);

  deleteOpen = $state(false);
  deleteResource = $state<Resource | null>(null);

  upsellOpen = $state(false);

  drainOpen = $state(false);
  drainNodeName = $state<string | null>(null);

  compareOpen = $state(false);
  compareResource = $state<Resource | null>(null);

  quickEditOpen = $state(false);
  quickEditResource = $state<Resource | null>(null);

  constructor() {
    super();
    unshadowState(this);
  }
}

export const dialogStore = new DialogStore();
