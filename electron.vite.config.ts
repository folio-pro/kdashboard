import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

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
      alias: {
        $lib: path.resolve("src/lib"),
      },
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: {
          index: path.resolve("index.html"),
          splashscreen: path.resolve("splashscreen.html"),
        },
        output: {
          manualChunks(id: string) {
            if (
              id.includes("/node_modules/codemirror/") ||
              id.includes("/node_modules/@codemirror/")
            ) {
              return "vendor-codemirror";
            }
            if (id.includes("/node_modules/@xterm/")) {
              return "vendor-xterm";
            }
            if (
              id.includes("/node_modules/bits-ui/") ||
              id.includes("/node_modules/@floating-ui/")
            ) {
              return "vendor-bits-ui";
            }
          },
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
    },
  },
});
