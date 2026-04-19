/** Payload emitted by Rust when an app update is available. */
export interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
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
  collapsed_sections: string[];
  table_density: "comfortable" | "compact";
  context_customizations: Record<string, ContextCustomization>;
  pinned_resources?: PinnedResource[];
}
