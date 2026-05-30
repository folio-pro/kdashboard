import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types/index.js";
import {
  SettingsStoreLogic,
  DEFAULT_SETTINGS,
  COLLAPSED_SECTIONS_MIGRATION_KEY,
} from "./settings.logic.js";
import { unshadowState } from "./_unshadow.js";

export type { AppSettings, ContextCustomization, PinnedResource } from "./settings.logic.js";

class SettingsStore extends SettingsStoreLogic {
  settings = $state<AppSettings>({ ...DEFAULT_SETTINGS });

  constructor() {
    super();
    unshadowState(this);
  }

  async loadSettings(): Promise<void> {
    try {
      const result = await invoke<AppSettings>("get_settings");
      const migrated = localStorage.getItem(COLLAPSED_SECTIONS_MIGRATION_KEY) === "1";
      const shouldApplyMigration = this.applyLoadedSettings(result, migrated);

      if (shouldApplyMigration) {
        localStorage.setItem(COLLAPSED_SECTIONS_MIGRATION_KEY, "1");
        this.saveSettings();
      }
    } catch {
      this.applyLoadError();
    }
  }

  override saveSettings(): void {
    invoke("save_settings", { settings: this.settings }).catch((err) => {
      if (import.meta.env.DEV) console.error("Failed to save settings:", err);
    });
  }

  protected override applyTheme(theme: string): void {
    document.documentElement.setAttribute("data-theme", theme);
    // The native macOS titlebar shows through to the webview background. In the
    // packaged build the WKWebView paints that background WHITE (in dev it stays
    // themed), so the titlebar looked white regardless of theme. Paint the
    // webview/window background with the theme's own colour so the titlebar
    // matches the theme exactly — not just generic dark/light.
    void this.syncNativeWindowTheme(theme);
  }

  private async syncNativeWindowTheme(theme: string): Promise<void> {
    try {
      const { isLightTheme, THEME_COLORS } = await import(
        "$lib/components/settings/settings-constants"
      );
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const bg = THEME_COLORS[theme]?.bg;
      if (bg) {
        // Paint both the window and the webview background: the packaged WKWebView
        // is the surface that defaults to white, while the window background backs
        // the transparent titlebar region. Theming both makes the titlebar match.
        await win.setBackgroundColor(bg);
        try {
          const { getCurrentWebview } = await import("@tauri-apps/api/webview");
          await getCurrentWebview().setBackgroundColor(bg);
        } catch {
          // Older runtime without webview background support — window bg is enough.
        }
      }
      // Keep native control glyphs (traffic lights, scrollbars) legible against
      // the themed background.
      await win.setTheme(isLightTheme(theme) ? "light" : "dark");
    } catch {
      // Non-Tauri context (browser/tests) or unsupported platform — ignore.
    }
  }
}

export const settingsStore = new SettingsStore();
