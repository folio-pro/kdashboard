// Bench-only Playwright config: identical to playwright.config.ts but pinned to
// its own port so runs never hit a dev server from another worktree/session
// (port 1420 is first-come; a stale server there silently benchmarks the WRONG
// code). --strictPort makes vite fail loudly instead of drifting to 1420.
import { defineConfig, devices } from "@playwright/test";

const PORT = 1421;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  reporter: "line",
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
