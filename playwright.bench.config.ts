// Same as playwright.config.ts but on port 1421. Port 1420 is often held by
// another worktree's dev server (electron-vite uses it too), which silently
// runs the e2e suite against the WRONG build. Use this config when 1420 may
// be taken: npx playwright test -c playwright.bench.config.ts
//
// BENCH_PROD=1 serves a production build (vite build + vite preview) instead
// of the dev server, so the perf benchmark measures the optimized bundle and
// the production Svelte runtime — the numbers a user actually gets. The bench
// store hook is opted in with VITE_KDASH_BENCH=1 (see src/main.ts).
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.RENDERER_PORT ?? 1421);
const PROD = process.env.BENCH_PROD === "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "line",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: PROD
      ? `VITE_KDASH_BENCH=1 npx vite build --outDir dist-bench --logLevel warn && npx vite preview --outDir dist-bench --port ${PORT} --strictPort`
      : `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Never reuse: a server already on this port may belong to another
    // checkout/worktree, which would run the suite against the wrong build.
    reuseExistingServer: false,
    timeout: 180000,
  },
});
