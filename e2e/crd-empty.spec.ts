/**
 * Regression: on a cluster with ZERO CRDs (or where discovery returns an empty
 * list, e.g. restricted RBAC), the Sidebar effect guarded on
 * `crdGroups.length === 0` — which is also the legitimate steady state — so it
 * re-fired discover_crds forever. Discovery completion is now tracked with the
 * explicit crdDiscovered flag.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const MOCK = clusterBootMock(`(cmd) => {
  if (cmd === "discover_crds") {
    window.__discoverCalls = (window.__discoverCalls ?? 0) + 1;
    return [];
  }
}`);

test("boot with zero CRDs does not loop discovery forever", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
  await expect(page.locator("body")).toBeVisible();

  await page.waitForTimeout(1_000);
  const calls = await page.evaluate("window.__discoverCalls");
  expect(calls).toBeLessThanOrEqual(1);
});
