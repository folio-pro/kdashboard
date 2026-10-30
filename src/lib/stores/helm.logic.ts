import type { HelmRelease, HelmReleaseDetail } from "$lib/types";

/** Status buckets the release table colours by. */
export type ReleaseHealth = "ok" | "pending" | "failed" | "unknown";

/** Map a helm status string onto the app's three status colours. */
export function releaseHealth(status: string): ReleaseHealth {
  const s = status.toLowerCase();
  if (s === "deployed" || s === "superseded") return "ok";
  if (s.startsWith("pending") || s === "uninstalling") return "pending";
  if (s === "failed" || s === "unknown" || s === "uninstalled") return s === "unknown" ? "unknown" : "failed";
  return "unknown";
}

/** Case-insensitive filter over the fields shown in the release table. */
export function filterReleases(releases: HelmRelease[], query: string): HelmRelease[] {
  const q = query.trim().toLowerCase();
  if (q === "") return releases;
  return releases.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.namespace.toLowerCase().includes(q) ||
      r.chart.toLowerCase().includes(q),
  );
}

export class HelmStoreLogic {
  releases: HelmRelease[] = [];
  selected: HelmReleaseDetail | null = null;
  history: HelmRelease[] = [];
  isLoading = false;
  error: string | null = null;
  /** Set when the cluster has no helm releases at all (not an error). */
  loaded = false;
  // Request generations: a response applies only when no newer load, reset
  // or (for the detail) clearSelection came since. The header's namespace
  // picker can fire loads faster than they return, and the last one to land
  // must not be an older namespace's.
  private _listGen = 0;
  private _detailGen = 0;

  beginListLoad(): number {
    return ++this._listGen;
  }

  isCurrentListLoad(token: number): boolean {
    return token === this._listGen;
  }

  beginDetailLoad(): number {
    return ++this._detailGen;
  }

  applyReleases(releases: HelmRelease[], token = this._listGen): void {
    if (token !== this._listGen) return;
    this.releases = releases;
    this.loaded = true;
    this.error = null;
  }

  applyError(message: string, token = this._listGen): void {
    if (token !== this._listGen) return;
    this.error = message;
    this.loaded = true;
  }

  applyDetail(detail: HelmReleaseDetail, history: HelmRelease[], token: number): void {
    if (token !== this._detailGen) return;
    this.selected = detail;
    this.history = history;
    this.error = null;
  }

  applyDetailError(message: string, token: number): void {
    if (token !== this._detailGen) return;
    this.error = message;
  }

  clearSelection(): void {
    this._detailGen++;
    this.selected = null;
    this.history = [];
  }

  reset(): void {
    this._listGen++;
    this._detailGen++;
    this.releases = [];
    this.selected = null;
    this.history = [];
    this.isLoading = false;
    this.error = null;
    this.loaded = false;
  }
}
