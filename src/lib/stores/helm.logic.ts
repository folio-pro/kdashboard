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

/** Stable identity for a release across namespaces. */
export function releaseKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

export class HelmStoreLogic {
  releases: HelmRelease[] = [];
  selected: HelmReleaseDetail | null = null;
  history: HelmRelease[] = [];
  isLoading = false;
  error: string | null = null;
  /** Set when the cluster has no helm releases at all (not an error). */
  loaded = false;

  applyReleases(releases: HelmRelease[]): void {
    this.releases = releases;
    this.loaded = true;
    this.error = null;
  }

  applyError(message: string): void {
    this.error = message;
    this.loaded = true;
  }

  reset(): void {
    this.releases = [];
    this.selected = null;
    this.history = [];
    this.isLoading = false;
    this.error = null;
    this.loaded = false;
  }
}
