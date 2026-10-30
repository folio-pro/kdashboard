/**
 * Switching kube context resets every cluster-scoped view store, so no view
 * shows the previous cluster's data (Helm used to reopen on the old
 * cluster's release detail).
 */
import { test, expect } from "./fixtures/mocked-cluster";

const NOW = new Date().toISOString();

const MOCK = `(cmd, args) => {
  window.__ctx = window.__ctx || "alpha";
  const release = (name) => ({ name, namespace: "default", revision: 1, status: "deployed", chart: "web", chart_version: "1.0.0", app_version: "1", updated: "${NOW}", description: "Install complete" });
  const releaseName = () => (window.__ctx === "alpha" ? "alpha-web" : "beta-api");
  if (cmd === "get_contexts") return ["alpha", "beta"];
  if (cmd === "get_current_context") return window.__ctx;
  if (cmd === "switch_context") { window.__ctx = args.context; return null; }
  if (cmd === "get_namespaces") return ["default"];
  if (cmd === "get_resource_counts") return {};
  if (cmd === "bench_config") return { enabled: false };
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "discover_crds") return [];
  if (cmd === "list_helm_releases") return [release(releaseName())];
  if (cmd === "list_helm_release_history") return [release(args.name)];
  if (cmd === "get_helm_release") return { ...release(args.name), values: {}, chart_values: {}, manifest: "kind: Service", notes: "" };
  return null;
}`;

test("Helm does not reopen on the previous cluster's release after a context switch", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  // Context alpha: open a release's detail.
  await page.getByRole("button", { name: /^Helm Releases/ }).first().click();
  await page.getByRole("button", { name: "Open Helm release alpha-web" }).click();
  await expect(page.getByRole("button", { name: "All releases" })).toBeVisible();

  // Switch to beta and reopen Helm: beta's list, nothing of alpha's.
  await page.locator('button[aria-label="Switch to context beta"]').click();
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Helm Releases/ }).first().click();
  await expect(page.getByRole("button", { name: "Open Helm release beta-api" })).toBeVisible();
  await expect(page.getByText("alpha-web")).toHaveCount(0);
});
