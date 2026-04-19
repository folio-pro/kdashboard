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
  }
}

export const settingsStore = new SettingsStore();
