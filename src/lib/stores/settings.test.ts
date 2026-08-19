import { describe, expect, test, beforeEach } from "bun:test";
import type { ContextCustomization } from "../types/index.js";
import { SettingsStoreLogic, DEFAULT_SETTINGS } from "./settings.logic.js";

/**
 * Testable subclass that tracks applyTheme calls and saveSettings calls
 * without needing Svelte runes or a backend invoke.
 */
class TestSettingsStore extends SettingsStoreLogic {
  appliedTheme: string = "";
  saveCallCount = 0;

  override saveSettings(): void {
    this.saveCallCount++;
  }

  protected override applyTheme(theme: string): void {
    this.appliedTheme = theme;
  }
}

describe("SettingsStore", () => {
  let store: TestSettingsStore;

  beforeEach(() => {
    store = new TestSettingsStore();
  });

  describe("initial state", () => {
    test("has correct defaults", () => {
      expect(store.settings.context).toBe("");
      expect(store.settings.namespace).toBe("default");
      expect(store.settings.theme_mode).toBe("kdashboard");
      expect(store.settings.kubeconfig_path).toBe("");
      expect(store.settings.table_density).toBe("comfortable");
      expect(store.settings.context_customizations).toEqual({});
    });
  });

  describe("applyLoadedSettings", () => {
    test("merges backend result with defaults", () => {
      store.applyLoadedSettings({
        context: "prod-cluster",
        namespace: "production",
        theme_mode: "gruvbox",
      });

      expect(store.settings.context).toBe("prod-cluster");
      expect(store.settings.namespace).toBe("production");
      expect(store.settings.theme_mode).toBe("gruvbox");
      expect(store.settings.kubeconfig_path).toBe(""); // default
      expect(store.appliedTheme).toBe("gruvbox");
    });

    test("defaults context_customizations to empty object", () => {
      store.applyLoadedSettings({});
      expect(store.settings.context_customizations).toEqual({});
    });

    test("preserves existing context_customizations", () => {
      const customs = { "my-ctx": { icon: "star", label: "Prod" } };
      store.applyLoadedSettings({
        context_customizations: customs,
      });
      expect(store.settings.context_customizations).toEqual(customs);
    });
  });

  describe("applyLoadError", () => {
    test("resets to defaults and applies default theme", () => {
      store.settings.theme_mode = "gruvbox";
      store.applyLoadError();
      expect(store.settings).toEqual(DEFAULT_SETTINGS);
      expect(store.appliedTheme).toBe("kdashboard");
    });
  });

  describe("updateTheme", () => {
    test("updates theme and saves", () => {
      store.updateTheme("solarized");
      expect(store.settings.theme_mode).toBe("solarized");
      expect(store.appliedTheme).toBe("solarized");
      expect(store.saveCallCount).toBe(1);
    });
  });

  describe("updateDensity", () => {
    test("updates density and saves", () => {
      store.updateDensity("compact");
      expect(store.settings.table_density).toBe("compact");
      expect(store.saveCallCount).toBe(1);
    });

    test("can switch back to comfortable", () => {
      store.updateDensity("compact");
      store.updateDensity("comfortable");
      expect(store.settings.table_density).toBe("comfortable");
    });
  });

  describe("updateKubeconfigPath", () => {
    test("updates path and saves", () => {
      store.updateKubeconfigPath("/home/user/.kube/config");
      expect(store.settings.kubeconfig_path).toBe("/home/user/.kube/config");
      expect(store.saveCallCount).toBe(1);
    });
  });

  describe("updateConnection", () => {
    test("updates context and namespace, then saves", () => {
      store.updateConnection("my-cluster", "prod");
      expect(store.settings.context).toBe("my-cluster");
      expect(store.settings.namespace).toBe("prod");
      expect(store.saveCallCount).toBe(1);
    });
  });

  describe("context customizations", () => {
    test("updateContextCustomization sets customization", () => {
      const custom: ContextCustomization = { icon: "rocket", label: "Production", color: "#ff0000" };
      store.updateContextCustomization("prod-ctx", custom);
      expect(store.settings.context_customizations["prod-ctx"]).toEqual(custom);
      expect(store.saveCallCount).toBe(1);
    });

    test("updateContextCustomization preserves other customizations", () => {
      store.updateContextCustomization("ctx-1", { icon: "star" });
      store.updateContextCustomization("ctx-2", { label: "Dev" });
      expect(store.settings.context_customizations["ctx-1"]).toEqual({ icon: "star" });
      expect(store.settings.context_customizations["ctx-2"]).toEqual({ label: "Dev" });
    });

    test("getContextCustomization returns existing customization", () => {
      const custom: ContextCustomization = { icon: "rocket" };
      store.updateContextCustomization("my-ctx", custom);
      expect(store.getContextCustomization("my-ctx")).toEqual(custom);
    });

    test("getContextCustomization returns undefined for unknown context", () => {
      expect(store.getContextCustomization("unknown")).toBeUndefined();
    });

    test("updateContextCustomization overwrites existing", () => {
      store.updateContextCustomization("ctx", { icon: "star" });
      store.updateContextCustomization("ctx", { icon: "rocket", label: "New" });
      expect(store.getContextCustomization("ctx")).toEqual({ icon: "rocket", label: "New" });
    });
  });
});
