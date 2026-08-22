import { isTableDensity, type AppSettings, type ContextCustomization, type PinnedResource, type SavedPortForward, type SavedView, type TableDensity, type WatchedResource } from "../types/index.js";

export type { AppSettings, ContextCustomization, PinnedResource };

type IdListKey = "saved_views" | "saved_port_forwards" | "watched_resources";

export const DEFAULT_SETTINGS: AppSettings = {
  context: "",
  namespace: "default",
  theme_mode: "kdashboard",
  kubeconfig_path: "",
  table_density: "comfortable",
  context_customizations: {},
  prometheus_url: "",
};

export class SettingsStoreLogic {
  settings: AppSettings = { ...DEFAULT_SETTINGS };

  private static readonly EMPTY_PINS: PinnedResource[] = [];

  /**
   * Apply loaded settings from backend. Pure logic extracted from loadSettings
   * (without invoke).
   */
  applyLoadedSettings(result: Partial<AppSettings>): void {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...result,
      context_customizations: result.context_customizations ?? {},
      // Validated here, once: a settings file written by an older build (or by
      // hand) may carry a value the density union does not know.
      table_density: isTableDensity(result.table_density) ? result.table_density : DEFAULT_SETTINGS.table_density,
    };
    this.applyTheme(this.settings.theme_mode);
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
   * to call the backend.
   */
  saveSettings(): void {
    // no-op — overridden in SvelteStore subclass
  }

  updateTheme(theme: string): void {
    this.settings.theme_mode = theme;
    this.applyTheme(theme);
    this.saveSettings();
  }

  updateDensity(density: TableDensity): void {
    this.settings.table_density = density;
    this.saveSettings();
  }

  updatePrometheusUrl(url: string): void {
    this.settings.prometheus_url = url;
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

  // --- id-keyed lists (saved views, saved forwards, watched resources) -------
  // Three lists, one shape: `{id}` items, insert-or-replace by id, remove by
  // id, and a stable empty reference so `$derived` readers do not re-run.

  private static readonly EMPTY: readonly never[] = [];

  private list<K extends IdListKey>(key: K): NonNullable<AppSettings[K]> {
    return (this.settings[key] ?? SettingsStoreLogic.EMPTY) as NonNullable<AppSettings[K]>;
  }

  private upsert<K extends IdListKey>(key: K, item: NonNullable<AppSettings[K]>[number]): void {
    const rest = (this.list(key) as Array<{ id: string }>).filter((x) => x.id !== item.id);
    (this.settings as Record<K, unknown>)[key] = [...rest, item];
    this.saveSettings();
  }

  private removeById(key: IdListKey, id: string): void {
    (this.settings as Record<IdListKey, unknown>)[key] = (this.list(key) as Array<{ id: string }>).filter((x) => x.id !== id);
    this.saveSettings();
  }

  get savedViews(): SavedView[] { return this.list("saved_views"); }
  addSavedView(view: SavedView): void { this.upsert("saved_views", view); }
  removeSavedView(id: string): void { this.removeById("saved_views", id); }

  get savedPortForwards(): SavedPortForward[] { return this.list("saved_port_forwards"); }
  /** Insert or replace by id. */
  upsertSavedPortForward(forward: SavedPortForward): void { this.upsert("saved_port_forwards", forward); }
  removeSavedPortForward(id: string): void { this.removeById("saved_port_forwards", id); }

  get watchedResources(): WatchedResource[] { return this.list("watched_resources"); }
  findWatched(context: string, kind: string, name: string, namespace?: string): WatchedResource | undefined {
    return this.watchedResources.find(
      (w) => w.context === context && w.kind === kind && w.name === name && (w.namespace ?? "") === (namespace ?? ""),
    );
  }
  watchResource(watched: WatchedResource): void {
    if (this.findWatched(watched.context, watched.kind, watched.name, watched.namespace)) return;
    this.upsert("watched_resources", watched);
  }
  unwatchResource(id: string): void { this.removeById("watched_resources", id); }

  getExtensionValue(key: string): unknown {
    return this.settings.extensions?.[key];
  }

  setExtensionValue(key: string, value: unknown): void {
    this.settings.extensions = { ...(this.settings.extensions ?? {}), [key]: value };
    this.saveSettings();
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
