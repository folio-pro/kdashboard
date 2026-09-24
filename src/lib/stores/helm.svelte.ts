import { invoke } from "$lib/ipc/core";
import { unshadowState } from "./_unshadow.js";
import type { HelmRelease, HelmReleaseDetail } from "$lib/types";
import { HelmStoreLogic } from "./helm.logic";

class HelmStore extends HelmStoreLogic {
  override releases = $state<HelmRelease[]>([]);
  override selected = $state<HelmReleaseDetail | null>(null);
  override history = $state<HelmRelease[]>([]);
  override isLoading = $state(false);
  override error = $state<string | null>(null);
  override loaded = $state(false);

  constructor() {
    super();
    unshadowState(this);
  }

  async loadReleases(namespace: string | null): Promise<void> {
    const token = this.beginListLoad();
    this.isLoading = true;
    try {
      this.applyReleases(await invoke<HelmRelease[]>("list_helm_releases", { namespace }), token);
    } catch (err) {
      this.applyError(String(err), token);
    } finally {
      if (this.isCurrentListLoad(token)) this.isLoading = false;
    }
  }

  /** Load one release's full payload plus its revision history. */
  async selectRelease(namespace: string, name: string, revision?: number): Promise<void> {
    const token = this.beginDetailLoad();
    this.isLoading = true;
    try {
      const [detail, history] = await Promise.all([
        invoke<HelmReleaseDetail>("get_helm_release", { namespace, name, revision: revision ?? null }),
        invoke<HelmRelease[]>("list_helm_release_history", { namespace, name }),
      ]);
      this.applyDetail(detail, history, token);
    } catch (err) {
      this.applyDetailError(String(err), token);
    } finally {
      // Unconditional: a detail load dropped by clearSelection (Back) has no
      // successor to clear the flag.
      this.isLoading = false;
    }
  }

  override reset(): void {
    super.reset();
    this.releases = [];
    this.selected = null;
    this.history = [];
    this.isLoading = false;
    this.error = null;
    this.loaded = false;
  }
}

export const helmStore = new HelmStore();
