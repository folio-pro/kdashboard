/**
 * End-to-end specs that exercise the UI's behavior when the Kubernetes cluster
 * is not reachable. Each test installs a Tauri IPC mock via addInitScript BEFORE
 * the app boots, so the connection error path runs from the very first invoke()
 * call. No real cluster is required.
 *
 * These tests require the dev server to be running (the webServer block in
 * playwright.config.ts handles this locally). In CI, the webServer is
 * disabled — these tests are skipped automatically when localhost:1420 is not
 * reachable. See playwright.config.ts for details.
 */

import { test, expect } from "./fixtures/mocked-cluster";

test.describe("Cluster unavailable", () => {
  test("shows the connection error overlay when get_contexts fails on boot", async ({
    page,
    mockTauriInvoke,
  }) => {
    await mockTauriInvoke(`(cmd) => {
      if (cmd === "get_contexts") throw new Error("dial tcp 10.0.0.1:6443: i/o timeout");
      if (cmd === "get_current_context") return "";
      if (cmd === "get_namespaces") return [];
      // Everything else: default empty-ish responses so the app doesn't crash
      // before it reaches the error state.
      return null;
    }`);

    await page.goto("/");

    // The ConnectionErrorOverlay renders whenever connectionStatus === "error".
    // Copy comes from src/lib/components/common/ConnectionErrorOverlay.svelte.
    await expect(page.getByText("Cluster connection lost")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /retry connection/i })).toBeVisible();
  });

  test("surfaces the underlying error message in the overlay body", async ({
    page,
    mockTauriInvoke,
  }) => {
    await mockTauriInvoke(`(cmd) => {
      if (cmd === "get_contexts") throw new Error("kubeconfig not found at /nonexistent/path");
      return null;
    }`);

    await page.goto("/");

    await expect(page.getByText(/kubeconfig not found/i)).toBeVisible({ timeout: 10_000 });
  });

  test("does not hang the UI — app chrome still renders", async ({ page, mockTauriInvoke }) => {
    await mockTauriInvoke(`(cmd) => {
      if (cmd === "get_contexts") throw new Error("cluster unreachable");
      return null;
    }`);

    await page.goto("/");

    // The overlay is an overlay on top of the app, not a replacement. The rest
    // of the app chrome (sidebar, status bar) must still be mounted so the user
    // can navigate to Settings and fix their kubeconfig.
    await expect(page.getByText("Cluster connection lost")).toBeVisible({ timeout: 10_000 });

    // Settings button is always rendered in the sidebar — prove that reaching
    // the error state didn't unmount the app shell.
    const settingsButton = page
      .getByRole("button", { name: /settings/i })
      .or(page.locator('[data-testid="settings-button"]'))
      .first();
    await expect(settingsButton).toBeVisible();
  });

  test("retry button is present and not stuck in a loading state on first render", async ({
    page,
    mockTauriInvoke,
  }) => {
    await mockTauriInvoke(`(cmd) => {
      if (cmd === "get_contexts") throw new Error("cluster unreachable");
      return null;
    }`);

    await page.goto("/");

    const retry = page.getByRole("button", { name: /retry connection/i });
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await expect(retry).toBeEnabled();
  });
});
