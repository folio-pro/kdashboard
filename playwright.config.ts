import { defineConfig, devices } from "@playwright/test";

// Mirrors vite.shared.ts: several worktrees of this repo are often running at
// once. With a hardcoded port plus reuseExistingServer, a sibling worktree's
// dev server on 1420 silently becomes the system under test — the suite then
// exercises the wrong app and fails on missing selectors.
const PORT = Number(process.env.RENDERER_PORT ?? 1420);
const BASE_URL = `http://localhost:${PORT}`;

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
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      },
  },
);
