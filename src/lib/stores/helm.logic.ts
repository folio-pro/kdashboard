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

/** The release (and optionally revision) the detail pane is showing or loading. */
export interface HelmDetailTarget {
  namespace: string;
  name: string;
  revision?: number;
}

/**
 * The release list and the release detail are two independent loads, each
 * with its own loading/error state and request id: a failed detail must not
 * hide the list, and neither load may clear the other's spinner. Every apply
 * checks its id, so an out-of-order response never overwrites a newer one.
 *
 * `releases`, `selected` and `history` are backend snapshots held in
 * `$state.raw` by the Svelte subclass — writers reassign, never mutate.
 */
export class HelmStoreLogic {
  releases: HelmRelease[] = [];
  selected: HelmReleaseDetail | null = null;
  history: HelmRelease[] = [];
  listLoading = false;
  listError: string | null = null;
  /** Set when the cluster has no helm releases at all (not an error). */
  loaded = false;
  /** Non-null while the detail pane is open, even before its payload lands. */
  detailTarget: HelmDetailTarget | null = null;
  detailLoading = false;
  detailError: string | null = null;
  protected _listLoadId = 0;
  protected _detailLoadId = 0;

  beginListLoad(): number {
    this.listLoading = true;
    return ++this._listLoadId;
  }

  applyReleasesIfCurrent(id: number, releases: HelmRelease[]): void {
    if (id !== this._listLoadId) return;
    this.releases = releases;
    this.loaded = true;
    this.listError = null;
    this.listLoading = false;
  }

  applyListErrorIfCurrent(id: number, message: string): void {
    if (id !== this._listLoadId) return;
    this.listError = message;
    this.loaded = true;
    this.listLoading = false;
  }

  /** Keeps the current `selected` on screen until the new payload lands. */
  beginDetailLoad(target: HelmDetailTarget): number {
    this.detailTarget = { ...target };
    this.detailLoading = true;
    this.detailError = null;
    return ++this._detailLoadId;
  }

  applyDetailIfCurrent(id: number, detail: HelmReleaseDetail, history: HelmRelease[]): void {
    if (id !== this._detailLoadId) return;
    this.selected = detail;
    this.history = history;
    this.detailError = null;
    this.detailLoading = false;
  }

  applyDetailErrorIfCurrent(id: number, message: string): void {
    if (id !== this._detailLoadId) return;
    this.detailError = message;
    this.detailLoading = false;
  }

  /** Back to the list: drops the detail and any in-flight detail load. */
  clearSelection(): void {
    this._detailLoadId++;
    this.detailTarget = null;
    this.selected = null;
    this.history = [];
    this.detailLoading = false;
    this.detailError = null;
  }

  reset(): void {
    this._listLoadId++;
    this.clearSelection();
    this.releases = [];
    this.listLoading = false;
    this.listError = null;
    this.loaded = false;
  }
}
