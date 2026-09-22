import { invoke } from "$lib/ipc/core";
import { unshadowState } from "./_unshadow.js";
import type { HelmRelease, HelmReleaseDetail } from "$lib/types";
import { HelmStoreLogic, type HelmDetailTarget } from "./helm.logic";

class HelmStore extends HelmStoreLogic {
  // $state.raw: backend snapshots, always replaced wholesale. `selected`
  // carries the full values/chart_values/manifest — deep-proxying them costs
  // a Proxy + signal per nested key for reactivity nothing uses.
  override releases = $state.raw<HelmRelease[]>([]);
  override selected = $state.raw<HelmReleaseDetail | null>(null);
  override history = $state.raw<HelmRelease[]>([]);
  override listLoading = $state(false);
  override listError = $state<string | null>(null);
  override loaded = $state(false);
  override detailTarget = $state.raw<HelmDetailTarget | null>(null);
  override detailLoading = $state(false);
  override detailError = $state<string | null>(null);

  constructor() {
    super();
    unshadowState(this);
  }

  async loadReleases(namespace: string | null): Promise<void> {
    const id = this.beginListLoad();
    try {
      this.applyReleasesIfCurrent(id, await invoke<HelmRelease[]>("list_helm_releases", { namespace }));
    } catch (err) {
      this.applyListErrorIfCurrent(id, String(err));
    }
  }

  /** Load one release's full payload plus its revision history. */
  async selectRelease(namespace: string, name: string, revision?: number): Promise<void> {
    const id = this.beginDetailLoad({ namespace, name, revision });
    try {
      const [detail, history] = await Promise.all([
        invoke<HelmReleaseDetail>("get_helm_release", { namespace, name, revision: revision ?? null }),
        invoke<HelmRelease[]>("list_helm_release_history", { namespace, name }),
      ]);
      this.applyDetailIfCurrent(id, detail, history);
    } catch (err) {
      this.applyDetailErrorIfCurrent(id, String(err));
    }
  }
}

export const helmStore = new HelmStore();
