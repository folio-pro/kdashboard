// Wire shapes for the Helm handlers (electron/handlers/helm.ts).

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chart_version: string;
  app_version: string;
  updated: string;
  description: string;
}

export interface HelmReleaseDetail extends HelmRelease {
  /** Values the user supplied. */
  values: Record<string, unknown>;
  /** The chart's default values. */
  chart_values: Record<string, unknown>;
  manifest: string;
  notes: string;
}
