/**
 * Regression guard for `uiStore.activeView`, which is derived from
 * `activeTab.type` rather than stored. Unit tests exercise the getter on the
 * plain logic class; only a real render proves it is *reactive* — if it were
 * not, the app would silently stop switching views.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const MOCK = clusterBootMock(`(cmd) => {
  if (cmd === "list_resources") return { items: [], columns: [] };
  if (cmd === "discover_crds") return [];
}`);

test("activeView follows the active tab reactively", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Boots on the Pods table.
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  // Sidebar navigation must swap the rendered view — this is the path that
  // used to depend on the manually-synced activeView field.
  await page.getByRole("button", { name: /^Deployments/ }).first().click();
  await expect(page.getByRole("heading", { name: "Deployments", exact: true })).toBeVisible();

  // A non-table view (its own header, no global title bar).
  await page.getByRole("button", { name: /^Port Forwards/ }).first().click();
  await expect(page.getByText("No active port forwards")).toBeVisible();

  // And back.
  await page.getByRole("button", { name: /^Pods/ }).first().click();
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible();
});
