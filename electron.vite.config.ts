import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { rendererAlias, codemirrorDedupe, vendorChunks, rendererPort } from "./vite.shared";

// electron-vite drives dev (renderer HMR + main/preload watch & auto-restart)
// and the production bundle. The standalone vite.config.ts is kept for the
// renderer-only path (npm run dev / Playwright e2e webServer).
//
// IMPORTANT: main/preload must bundle every dep. electron-vite 5 externalizes
// anything listed under `dependencies` by default (`build.externalizeDeps`
// defaults to true; the old externalizeDepsPlugin is deprecated), so bundling
// is expressed the way electron-vite documents it: package.json keeps only
// electron-updater under `dependencies` and everything else under
// `devDependencies`. Adding a runtime dep back to `dependencies` silently
// un-bundles it AND makes electron-builder copy it into the asar.
// electron-updater is the one exception — handlers/updater.ts require()s it
// lazily at runtime, so it has to ship as real files inside the asar.
export default defineConfig({
  main: {
    build: {
      // ws probes for two optional native accelerators (bufferutil,
      // utf-8-validate) inside a try/catch and falls back to pure JS when they
      // are absent — which they are here, deliberately: they are native, and
      // bundling exists to keep native modules out of the asar. Left to
      // itself the bundler replaces the unresolved import with a stub that
      // THROWS AT MODULE SCOPE, hoisting the failure out of ws's try/catch and
      // killing the main process on load. `ignore` leaves the two require()
      // calls alone so they fail where ws expects them to, inside the catch.
      commonjsOptions: {
        ignore: ["bufferutil", "utf-8-validate"],
      },
      rollupOptions: {
        input: { index: path.resolve("electron/main.ts") },
        // node-pty is a NATIVE module (pty.node + spawn-helper binaries): it
        // cannot be bundled, so it is the second entry under `dependencies`
        // (electron-builder ships production deps automatically) and is
        // asarUnpack'ed so the binaries can be exec'd. Listed here too so the
        // bundler never tries to inline it.
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
