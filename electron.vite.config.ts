import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { rendererAlias, codemirrorDedupe, vendorChunks, rendererPort } from "./vite.shared";

// electron-vite drives dev (renderer HMR + main/preload watch & auto-restart)
// and the production bundle. The standalone vite.config.ts is kept for the
// renderer-only path (npm run dev / Playwright e2e webServer).
//
// IMPORTANT: we deliberately do NOT use externalizeDepsPlugin for main/preload.
// @kubernetes/client-node is ESM-only; externalizing it would re-introduce
// ERR_REQUIRE_ESM at runtime. Bundling every dep (electron-vite still
// externalizes Node built-ins + electron) avoids that, matching the prior
// esbuild --external:electron setup.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: path.resolve("electron/main.ts") },
        external: ["electron"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: path.resolve("electron/preload.ts") },
        external: ["electron"],
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [svelte(), tailwindcss()],
    resolve: {
      alias: rendererAlias,
      dedupe: codemirrorDedupe,
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: {
          index: path.resolve("index.html"),
          splashscreen: path.resolve("splashscreen.html"),
        },
        output: {
          manualChunks: vendorChunks,
        },
      },
    },
    server: {
      port: rendererPort,
      strictPort: true,
    },
  },
});
