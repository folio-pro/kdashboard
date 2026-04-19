import type { AppSettings, ContextCustomization, PinnedResource } from "../types/index.js";

export type { AppSettings, ContextCustomization, PinnedResource };

export const DEFAULT_SETTINGS: AppSettings = {
  context: "",
  namespace: "default",
  theme_mode: "kdashboard",
  kubeconfig_path: "",
  collapsed_sections: ["storage", "rbac", "scaling"],
  table_density: "comfortable",
  context_customizations: {},
};

export const COLLAPSED_SECTIONS_MIGRATION_KEY = "kdashboard-collapsed-sections-v1-migrated";

export class SettingsStoreLogic {
  settings: AppSettings = { ...DEFAULT_SETTINGS };

  private static readonly EMPTY_PINS: PinnedResource[] = [];

  /**
   * Apply loaded settings from backend, handling the collapsed_sections migration.
   * This is the pure logic extracted from loadSettings (without invoke/localStorage).
   */
  applyLoadedSettings(result: Partial<AppSettings>, migrated: boolean): boolean {
    const shouldApplyMigration =
      !migrated &&
      Array.isArray(result.collapsed_sections) &&
      result.collapsed_sections.length === 0;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...result,
      collapsed_sections: shouldApplyMigration
        ? [...DEFAULT_SETTINGS.collapsed_sections]
        : (result.collapsed_sections ?? DEFAULT_SETTINGS.collapsed_sections),
      context_customizations: result.context_customizations ?? {},
    };
    this.applyTheme(this.settings.theme_mode);

    return shouldApplyMigration;
  }

  /**
   * Reset to defaults on load error.
   */
  applyLoadError(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.applyTheme(DEFAULT_SETTINGS.theme_mode);
  }

  /**
   * Persist settings. No-op in the logic class; overridden in the Svelte store
   * to call Tauri invoke.
   */
  saveSettings(): void {
    // no-op — overridden in SvelteStore subclass
  }

  updateTheme(theme: string): void {
    this.settings.theme_mode = theme;
    this.applyTheme(theme);
    this.saveSettings();
  }

  updateDensity(density: "comfortable" | "compact"): void {
    this.settings.table_density = density;
    this.saveSettings();
  }

  updateKubeconfigPath(path: string): void {
    this.settings.kubeconfig_path = path;
    this.saveSettings();
  }

  updateConnection(context: string, namespace: string): void {
    this.settings.context = context;
    this.settings.namespace = namespace;
    this.saveSettings();
  }

  toggleCollapsedSection(section: string): void {
    const idx = this.settings.collapsed_sections.indexOf(section);
    if (idx >= 0) {
      this.settings.collapsed_sections = this.settings.collapsed_sections.filter(
        (s) => s !== section,
      );
    } else {
      this.settings.collapsed_sections = [...this.settings.collapsed_sections, section];
    }
    this.saveSettings();
  }

  updateContextCustomization(context: string, customization: ContextCustomization): void {
    this.settings.context_customizations = {
      ...(this.settings.context_customizations ?? {}),
      [context]: customization,
    };
    this.saveSettings();
  }

  getContextCustomization(context: string): ContextCustomization | undefined {
    return this.settings.context_customizations?.[context];
  }

  isSectionCollapsed(section: string): boolean {
    return this.settings.collapsed_sections.includes(section);
  }

  get pinnedResources(): PinnedResource[] {
    return this.settings.pinned_resources ?? SettingsStoreLogic.EMPTY_PINS;
  }

  isPinned(kind: string, name: string, namespace?: string): boolean {
    return this.pinnedResources.some(
      (p) => p.kind === kind && p.name === name && p.namespace === namespace,
    );
  }

  pinResource(pin: PinnedResource): void {
    if (this.isPinned(pin.kind, pin.name, pin.namespace)) return;
    this.settings.pinned_resources = [...this.pinnedResources, pin];
    this.saveSettings();
  }

  unpinResource(kind: string, name: string, namespace?: string): void {
    this.settings.pinned_resources = this.pinnedResources.filter(
      (p) => !(p.kind === kind && p.name === name && p.namespace === namespace),
    );
    this.saveSettings();
  }

  /**
   * Apply theme to the DOM. Protected so the Svelte store can override with
   * document.documentElement.setAttribute, while tests can stub it.
   */
  protected applyTheme(theme: string): void {
    // no-op in base class — overridden in SvelteStore subclass
    void theme;
  }
}
