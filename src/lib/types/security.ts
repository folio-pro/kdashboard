// Security Types

export interface VulnerabilityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface ImageScanResult {
  image: string;
  vulns: VulnerabilityCounts;
  scanned_at: string;
  /** `failed` carries empty counts — nothing was looked at. Absent on older payloads: treat as scanned. */
  status?: "scanned" | "failed";
  error?: string;
}

export interface PodSecurityInfo {
  name: string;
  namespace: string;
  images: ImageScanResult[];
  /** Images with no scan result at all (no scanner installed). Absent on older payloads. */
  unscanned_images?: string[];
  total_vulns: VulnerabilityCounts;
  compliant: boolean;
}

export interface SecurityOverview {
  pods: PodSecurityInfo[];
  total_vulns: VulnerabilityCounts;
  total_images_scanned: number;
  compliant_pods: number;
  non_compliant_pods: number;
  scanner: string;
  fetched_at: string;
}
