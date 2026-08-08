// Renderer build settings shared by the two entry configs: the standalone
// vite.config.ts (npm run dev / Playwright e2e webServer) and the renderer
// section of electron.vite.config.ts (electron-vite dev + production bundle).
import path from "node:path";

export const rendererAlias = {
  $lib: path.resolve("src/lib"),
};

// Multiple worktrees of this repo are often active at once and each dev server
// binds strictPort — allow overriding so parallel checkouts don't collide.
export const rendererPort = Number(process.env.RENDERER_PORT ?? 1420);

// CodeMirror extensions break with "Unrecognized extension value" if two
// copies of these packages end up in the bundle — force a single instance.
export const codemirrorDedupe = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/language",
];

// Split heavy deps into separate chunks for better caching.
// Function form is required by Rolldown (Vite 8+).
export function vendorChunks(id: string): string | undefined {
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
  return undefined;
}
