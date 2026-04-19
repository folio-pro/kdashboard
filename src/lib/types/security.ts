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
}

export interface PodSecurityInfo {
  name: string;
  namespace: string;
  images: ImageScanResult[];
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
