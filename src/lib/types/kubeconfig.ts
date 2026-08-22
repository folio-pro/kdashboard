// Kubeconfig import wire types — mirror electron/k8s/kubeconfig-merge.ts.

export type KubeconfigPreviewStatus = "new" | "identical" | "conflict";

export interface KubeconfigPreviewRow {
  name: string;
  cluster: string;
  user: string;
  server?: string;
  namespace?: string;
  status: KubeconfigPreviewStatus;
}

export interface KubeconfigMergeSection {
  added: string[];
  replaced: string[];
  skipped: string[];
}

export interface KubeconfigPreview {
  file: string;
  source: string;
  rows: KubeconfigPreviewRow[];
}

export interface KubeconfigImportResult {
  file: string;
  backup: string | null;
  contexts: KubeconfigMergeSection;
  clusters: KubeconfigMergeSection;
  users: KubeconfigMergeSection;
}
