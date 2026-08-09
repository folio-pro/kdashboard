/** Payload emitted by the main process when an app update is available. */
export interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  /** True when in-app install is unavailable (unsigned macOS builds) and the
   *  user must update via Homebrew: `brew upgrade --cask kdashboard`. */
  manualInstall?: boolean;
}

export interface ContextCustomization {
  icon?: string;
  label?: string;
  color?: string;
}

export interface PinnedResource {
  kind: string;
  name: string;
  namespace?: string;
  resourceType: string;
}

export interface AppSettings {
  context: string;
  namespace: string;
  theme_mode: string;
  kubeconfig_path: string;
  table_density: "comfortable" | "compact";
  context_customizations: Record<string, ContextCustomization>;
  pinned_resources?: PinnedResource[];
  /** Base URL of a Prometheus reachable from this machine. Empty = disabled. */
  prometheus_url?: string;
}
