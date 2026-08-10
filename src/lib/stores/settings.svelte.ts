import { invoke, readBootSettings } from "$lib/ipc/core";
import type { AppSettings } from "../types/index.js";
import { SettingsStoreLogic, DEFAULT_SETTINGS } from "./settings.logic.js";
import { unshadowState } from "./_unshadow.js";

export type { AppSettings, ContextCustomization, PinnedResource } from "./settings.logic.js";

class SettingsStore extends SettingsStoreLogic {
  settings = $state<AppSettings>({ ...DEFAULT_SETTINGS });

  constructor() {
    super();
    unshadowState(this);
  }

  async loadSettings(): Promise<void> {
    // Prefer the synchronous bridge read: main serves the SAME in-memory object
    // that get_settings returns, so this is authoritative, and it saves an IPC
    // round-trip on the boot path. Null under `npm run dev` / Playwright (no
    // preload), where the async path below still applies.
    const boot = readBootSettings();
    if (boot) {
      this.applyLoadedSettings(boot as Partial<AppSettings>);
      return;
    }

    try {
      const result = await invoke<AppSettings>("get_settings");
      this.applyLoadedSettings(result);
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
