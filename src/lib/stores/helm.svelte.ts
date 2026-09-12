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

  // A slow response for an earlier release/namespace must not overwrite a
  // newer one. Every async op (and any invalidation) bumps the generation;
  // only the latest owns the result and clears `isLoading`.
  private _gen = 0;

  async loadReleases(namespace: string | null): Promise<void> {
    const gen = ++this._gen;
    this.isLoading = true;
    try {
      const releases = await invoke<HelmRelease[]>("list_helm_releases", { namespace });
      if (gen !== this._gen) return;
      this.applyReleases(releases);
    } catch (err) {
      if (gen !== this._gen) return;
      this.applyError(String(err));
    } finally {
      if (gen === this._gen) this.isLoading = false;
    }
  }

  /** Load one release's full payload plus its revision history. */
  async selectRelease(namespace: string, name: string, revision?: number): Promise<void> {
    const gen = ++this._gen;
    this.isLoading = true;
    try {
      const [detail, history] = await Promise.all([
        invoke<HelmReleaseDetail>("get_helm_release", { namespace, name, revision: revision ?? null }),
        invoke<HelmRelease[]>("list_helm_release_history", { namespace, name }),
      ]);
      if (gen !== this._gen) return;
      this.selected = detail;
      this.history = history;
      this.error = null;
    } catch (err) {
      if (gen !== this._gen) return;
      this.error = String(err);
    } finally {
      if (gen === this._gen) this.isLoading = false;
    }
  }

  clearSelection(): void {
    this._gen++;
    this.selected = null;
    this.history = [];
    this.isLoading = false;
  }

  override reset(): void {
    super.reset();
    this._gen++;
    this.releases = [];
    this.selected = null;
    this.history = [];
    this.isLoading = false;
    this.error = null;
    this.loaded = false;
  }
}

export const helmStore = new HelmStore();
