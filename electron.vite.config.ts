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
        // node-pty is a NATIVE module (pty.node + spawn-helper binaries): it
        // cannot be bundled, so it stays external and is shipped via the
        // electron-builder files list (package.json build.files).
        external: ["electron", "node-pty"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: path.resolve("electron/preload.ts") },
        external: ["electron"],
        // CJS, not the default ESM: a preload running in a SANDBOXED renderer
        // (webPreferences.sandbox: true in electron/main.ts) cannot be an ES
        // module. Electron loads sandboxed preloads through its own limited
        // require() shim, which only understands CommonJS.
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
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
