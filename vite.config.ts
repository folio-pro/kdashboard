import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
      // --- Tauri -> Electron shims ---
      // Keep the Svelte UI's `@tauri-apps/*` imports working unchanged by
      // redirecting them to thin shims that delegate to window.electronAPI.
      "@tauri-apps/api/core": path.resolve("./src/lib/shims/tauri-core.ts"),
      "@tauri-apps/api/event": path.resolve("./src/lib/shims/tauri-event.ts"),
      "@tauri-apps/api/window": path.resolve("./src/lib/shims/tauri-window.ts"),
      "@tauri-apps/plugin-shell": path.resolve("./src/lib/shims/tauri-shell.ts"),
      "@tauri-apps/plugin-process": path.resolve("./src/lib/shims/tauri-process.ts"),
      "@tauri-apps/plugin-updater": path.resolve("./src/lib/shims/tauri-updater.ts"),
    },
  },
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split heavy deps into separate chunks for better caching.
        // Function form is required by Rolldown (Vite 8+).
        manualChunks(id) {
          if (id.includes("/node_modules/codemirror/") || id.includes("/node_modules/@codemirror/")) {
            return "vendor-codemirror";
          }
          if (id.includes("/node_modules/@xterm/")) {
            return "vendor-xterm";
          }
          // bits-ui + its @floating-ui dependency are heavy and eagerly loaded;
          // isolate them so app-code edits don't bust their cache entry.
          if (id.includes("/node_modules/bits-ui/") || id.includes("/node_modules/@floating-ui/")) {
            return "vendor-bits-ui";
          }
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
