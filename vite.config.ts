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
    },
  },
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split heavy deps into separate chunks for better caching
          "vendor-codemirror": [
            "codemirror",
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/lang-yaml",
            "@codemirror/language",
            "@codemirror/commands",
            "@codemirror/search",
            "@codemirror/autocomplete",
            "@codemirror/lint",
            "@codemirror/merge",
          ],
          "vendor-xterm": ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"],
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
