import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { extensions } from "$lib/extensions";
import { readBootSettings } from "$lib/ipc/core";

// Apply the persisted theme BEFORE mounting. settingsStore.loadSettings() sets
// the same attribute, but it runs from App.svelte's onMount — by then the first
// frame is already on screen with no data-theme, which is a visible flash on
// every light theme (see the 11 palettes in app.css). The bridge read is
// synchronous precisely so this can happen ahead of first paint.
//
// No-op under `npm run dev` / Playwright (no preload); settingsStore's async
// path covers those.
function applyBootTheme(): void {
  const theme = readBootSettings()?.theme_mode;
  if (typeof theme === "string" && theme.length > 0) {
    document.documentElement.setAttribute("data-theme", theme);
  }
}
applyBootTheme();

// No registrations are made in the core bundle. Sealing now guarantees that
// any accidental attempt to register extensions after mount fails loudly.
extensions.seal();

const app = mount(App, {
  target: document.getElementById("app")!,
});

// Startup hooks run after mount so the UI is interactive immediately.
extensions.runStartupHooks().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Extension startup hook failed:", err);
});

// Warm heavy lazy-view chunks during idle time so the first open of the detail
// panel / logs / terminal / YAML editor is instant rather than a chunk-fetch
// stutter. Best-effort, idle-gated — never competes with first paint or input.
import("$lib/utils/preload").then((m) => m.preloadHeavyViews()).catch(() => {});

// DEV/E2E-only: expose the live stores on window so the reproducible frontend
// benchmark harness (e2e/perf-bench.spec.ts) can inject synthetic datasets and
// drive the real render path without a cluster. Tree-shaken out of prod builds
// (import.meta.env.DEV is statically false there).
if (import.meta.env.DEV) {
  void Promise.all([
    import("$lib/stores/k8s.svelte"),
    import("$lib/stores/ui.svelte"),
    import("$lib/stores/settings.svelte"),
  ]).then(([k8s, ui, settings]) => {
    (window as unknown as Record<string, unknown>).__kdash = {
      k8sStore: k8s.k8sStore,
      uiStore: ui.uiStore,
      settingsStore: settings.settingsStore,
    };
  });
}

export default app;
