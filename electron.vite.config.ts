import { defineConfig, type Plugin } from "electron-vite";
import { relocateEsmShimCode } from "./electron/build/esm-shim";
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
/**
 * electron-vite's ESM shim (`__dirname`, `__filename`, `require`) can land in
 * the wrong place — see electron/build/esm-shim.ts. This post plugin runs
 * after electron-vite's and moves the shim after the real last top-level
 * import.
 */
function relocateEsmShim(): Plugin {
  return {
    name: "kdash:relocate-esm-shim",
    enforce: "post",
    renderChunk(code, _chunk, { format }) {
      if (format !== "es") return null;
      const relocated = relocateEsmShimCode(code);
      return relocated === code ? null : { code: relocated, map: null };
    },
  };
}

export default defineConfig({
  main: {
    plugins: [relocateEsmShim()],
    build: {
      // electron-vite leaves every bundle UNMINIFIED by default (`minify: false`
      // for main, preload and renderer alike). Main alone weighs ~10 MB
      // unminified because @kubernetes/client-node ships three generated
      // layers per API plus ~700 model classes; the same code minifies to
      // ~4 MB. Every byte is read and parsed on each launch, so minifying is
      // a cold-start and memory win with no runtime cost.
      minify: "esbuild",
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
        // bootstrap.ts enables Node's compile cache, then dynamically imports
        // ./main — which electron-vite therefore emits as its own chunk, the one
        // the cache covers. See electron/bootstrap.ts.
        input: { index: path.resolve("electron/bootstrap.ts") },
        // node-pty is a NATIVE module (pty.node + spawn-helper binaries): it
        // cannot be bundled, so it is the second entry under `dependencies`
        // (electron-builder ships production deps automatically) and is
        // asarUnpack'ed so the binaries can be exec'd. Listed here too so the
        // bundler never tries to inline it.
        external: ["electron", "node-pty"],
        output: {
          // Keep the ./main chunk next to index.js instead of under chunks/:
          // main.ts resolves the preload and renderer files relative to
          // __dirname, which is the chunk's own directory.
          chunkFileNames: "[name]-[hash].js",
        },
      },
    },
  },
  preload: {
    build: {
      minify: "esbuild",
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
      minify: "esbuild",
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
