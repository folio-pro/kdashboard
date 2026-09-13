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
  // newer one. The list and the detail are INDEPENDENT streams with their own
  // generation: a shared counter made clearSelection() (the Back button) drop
  // a list refresh that was still on its way, leaving the table stale forever.
  private _listGen = 0;
  private _detailGen = 0;
  // Ops still owning `isLoading`; the flag drops when the last one settles, so
  // a finished list load can't hide the spinner of a detail load beside it.
  private _inFlight = 0;

  private _beginLoad(): void {
    this._inFlight++;
    this.isLoading = true;
  }

  private _endLoad(): void {
    this._inFlight = Math.max(0, this._inFlight - 1);
    if (this._inFlight === 0) this.isLoading = false;
  }

  async loadReleases(namespace: string | null): Promise<void> {
    const gen = ++this._listGen;
    this._beginLoad();
    try {
      const releases = await invoke<HelmRelease[]>("list_helm_releases", { namespace });
      if (gen !== this._listGen) return;
      this.applyReleases(releases);
    } catch (err) {
      if (gen !== this._listGen) return;
      this.applyError(String(err));
    } finally {
      this._endLoad();
    }
  }

  /** Load one release's full payload plus its revision history. */
  async selectRelease(namespace: string, name: string, revision?: number): Promise<void> {
    const gen = ++this._detailGen;
    this._beginLoad();
    try {
      const [detail, history] = await Promise.all([
        invoke<HelmReleaseDetail>("get_helm_release", { namespace, name, revision: revision ?? null }),
        invoke<HelmRelease[]>("list_helm_release_history", { namespace, name }),
      ]);
      if (gen !== this._detailGen) return;
      this.selected = detail;
      this.history = history;
      this.error = null;
    } catch (err) {
      if (gen !== this._detailGen) return;
      this.error = String(err);
    } finally {
      this._endLoad();
    }
  }

  clearSelection(): void {
    // Detail only — a list load in flight keeps running and still lands.
    this._detailGen++;
    this.selected = null;
    this.history = [];
  }

  override reset(): void {
    super.reset();
    this._listGen++;
    this._detailGen++;
    this._inFlight = 0;
    this.releases = [];
    this.selected = null;
    this.history = [];
    this.isLoading = false;
    this.error = null;
    this.loaded = false;
  }
}

export const helmStore = new HelmStore();
