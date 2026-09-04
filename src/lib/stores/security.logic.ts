import { AsyncLoadStoreLogic } from "./async-load.logic";
import type { PodSecurityInfo, SecurityOverview, VulnerabilityCounts } from "$lib/types";

export class SecurityStoreLogic extends AsyncLoadStoreLogic<SecurityOverview> {
  /** Alias for readability in templates */
  get overview() { return this.data; }
}

export function vulnTotal(v: VulnerabilityCounts): number {
  return v.critical + v.high + v.medium + v.low + v.unknown;
}

/**
 * How much of a pod the scanner actually looked at. Zero findings on a pod
 * nobody scanned used to render as "No vulnerabilities" — fifteen green rows
 * with no scanner installed — so the summary keeps "scanned clean" apart from
 * "not scanned" and "scan failed".
 */
export interface PodScanSummary {
  /** Images with a successful scan. */
  scanned: number;
  /** Images with no successful scan: failed, or never attempted. */
  missing: number;
  /** At least one scan was attempted and failed. */
  failed: boolean;
  /** Findings across the scanned images. */
  vulns: number;
}

export function podScanSummary(pod: PodSecurityInfo): PodScanSummary {
  let scanned = 0;
  let failed = false;
  for (const img of pod.images) {
    // `status` is absent on payloads from an older backend, which only ever
    // reported successful scans.
    if (img.status === "failed") failed = true;
    else scanned += 1;
  }
  const missing = pod.images.length - scanned + (pod.unscanned_images?.length ?? 0);
  return { scanned, missing, failed, vulns: vulnTotal(pod.total_vulns) };
}

export type PodScanState = "clean" | "vulnerable" | "partial" | "unscanned" | "failed";

/** One word for the row: what the badges (or their absence) mean. */
export function podScanState(s: PodScanSummary): PodScanState {
  if (s.scanned === 0) return s.failed ? "failed" : "unscanned";
  if (s.vulns > 0) return "vulnerable";
  return s.missing > 0 ? "partial" : "clean";
}

/**
 * The muted or green line that stands in for severity badges when a pod has
 * none to show. `null` when the badges speak for themselves.
 */
export function podScanLabel(s: PodScanSummary): { text: string; tone: "success" | "muted" } | null {
  switch (podScanState(s)) {
    case "failed":
      return { text: "Scan failed", tone: "muted" };
    case "unscanned":
      return { text: "Not scanned", tone: "muted" };
    case "partial":
      return { text: `No vulnerabilities · ${s.missing} not scanned`, tone: "muted" };
    case "clean":
      return { text: "No vulnerabilities", tone: "success" };
    default:
      return null;
  }
}
