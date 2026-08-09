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
    this.isLoading = true;
    try {
      this.applyReleases(await invoke<HelmRelease[]>("list_helm_releases", { namespace }));
    } catch (err) {
      this.applyError(String(err));
    } finally {
      this.isLoading = false;
    }
  }

  /** Load one release's full payload plus its revision history. */
  async selectRelease(namespace: string, name: string, revision?: number): Promise<void> {
    this.isLoading = true;
    try {
      const [detail, history] = await Promise.all([
        invoke<HelmReleaseDetail>("get_helm_release", { namespace, name, revision: revision ?? null }),
        invoke<HelmRelease[]>("list_helm_release_history", { namespace, name }),
      ]);
      this.selected = detail;
      this.history = history;
      this.error = null;
    } catch (err) {
      this.error = String(err);
    } finally {
      this.isLoading = false;
    }
  }

  clearSelection(): void {
    this.selected = null;
    this.history = [];
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
