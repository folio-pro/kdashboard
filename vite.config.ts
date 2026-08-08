import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { rendererAlias, codemirrorDedupe, vendorChunks } from "./vite.shared";

export default defineConfig(async () => ({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: rendererAlias,
    dedupe: codemirrorDedupe,
  },
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: vendorChunks,
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
}));
