/**
 * Desktop alerts: watch a resource from its context menu, get the baseline
 * verdict right away, see it in the status-bar bell, and stop watching.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const created = new Date(Date.now() - 3_600_000).toISOString();

const CRASHING = {
  kind: "Pod",
  api_version: "v1",
  metadata: { name: "crashy", namespace: "default", uid: "pod-crashy", creation_timestamp: created, labels: {}, annotations: {}, owner_references: [], resource_version: "1" },
  spec: { containers: [{ name: "app", image: "acme/app:1" }] },
  status: {
    phase: "Running",
    containerStatuses: [
      { name: "app", image: "acme/app:1", ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 1m20s restarting failed container" } }, lastState: { terminated: { exitCode: 1, reason: "Error", finishedAt: created } } },
    ],
  },
};

const MOCK = clusterBootMock(`(cmd, args) => {
  const pod = ${JSON.stringify(CRASHING)};
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: args.resourceType === "pods" ? [pod] : [] };
  if (cmd === "get_resource") return args.name === "crashy" ? pod : null;
  if (cmd === "get_resource_events") return [{ type: "Warning", reason: "BackOff", message: "Back-off restarting failed container", count: 7, last_timestamp: "${created}" }];
  if (cmd === "save_settings") return null;
  if (cmd === "get_pod_metrics") return { available: false, reason: "mock", pods: [] };
  if (cmd === "discover_crds") return [];
}`);

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
});

test("watching a broken pod reports its state at once and shows in the status bar", async ({ page }) => {
  await expect(page.locator('[data-testid="alerts-indicator"]')).toHaveCount(0);

  await page.locator("tbody tr").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Watch for Alerts" }).click();

  // Baseline verdict as a toast, and the bell counts one watched resource.
  await expect(page.getByText("Watching Pod default/crashy")).toBeVisible();
  await expect(page.getByText(/Currently CrashLoopBackOff — app: back-off/)).toBeVisible();
  const bell = page.locator('[data-testid="alerts-indicator"]');
  await expect(bell).toContainText("1");

  // The menu now offers the inverse action.
  await page.locator("tbody tr").first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Stop Watching" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The popover lists the watched object and the recent alert; unwatch clears it.
  await bell.click();
  const popover = page.locator('[data-testid="alerts-popover"]');
  await expect(popover).toContainText("Pod default/crashy");
  await expect(popover).toContainText("Watching Pod default/crashy");
  await popover.getByRole("button", { name: "unwatch" }).click();
  await expect(page.locator('[data-testid="alerts-indicator"]')).toHaveCount(0);
});
