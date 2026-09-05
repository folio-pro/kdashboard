/**
 * Cost → Rightsizing: requests vs usage per workload, filters, and the
 * apply-recommendation dialog that server-side-applies only the changed
 * container requests.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const MI = 1024 * 1024;
const RIGHTSIZING = {
  scope: "cluster",
  namespace: null,
  usage_source: "metrics-server",
  usage_window: "now",
  cpu_rate_per_core_hour: 0.0325,
  memory_rate_per_gb_hour: 0.0044,
  total_saving_monthly: 61.2,
  over_count: 1,
  under_count: 1,
  fetched_at: new Date().toISOString(),
  workloads: [
    {
      id: "Deployment/shop/web", kind: "Deployment", name: "web", namespace: "shop", replicas: 3, verdict: "over", saving_monthly: 61.2, cpu_delta: 2.4, memory_delta: 2112 * MI,
      containers: [
        { container: "app", cpu_request: 1, memory_request: 1024 * MI, cpu_limit: 2, memory_limit: null, cpu_usage: 0.15, memory_usage: 250 * MI, cpu_recommended: 0.2, memory_recommended: 320 * MI, cpu_verdict: "over", memory_verdict: "over" },
        { container: "sidecar", cpu_request: 0.05, memory_request: 64 * MI, cpu_limit: null, memory_limit: null, cpu_usage: 0.02, memory_usage: 40 * MI, cpu_recommended: 0.03, memory_recommended: 56 * MI, cpu_verdict: "ok", memory_verdict: "ok" },
      ],
    },
    {
      id: "StatefulSet/msg/kafka", kind: "StatefulSet", name: "kafka", namespace: "msg", replicas: 3, verdict: "under", saving_monthly: -9.4, cpu_delta: -0.3, memory_delta: 0,
      containers: [{ container: "kafka", cpu_request: 0.5, memory_request: 2048 * MI, cpu_limit: null, memory_limit: null, cpu_usage: 0.49, memory_usage: 1500 * MI, cpu_recommended: 0.65, memory_recommended: 1888 * MI, cpu_verdict: "under", memory_verdict: "ok" }],
    },
  ],
};

const COST = { namespaces: [], cluster_cost_hourly: 0, cluster_cost_monthly: 0, total_cpu_cores: 0, total_memory_gb: 0, cpu_rate_per_core_hour: 0.0325, memory_rate_per_gb_hour: 0.0044, source: "fallback", fetched_at: new Date().toISOString() };

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "get_cost_overview") return ${JSON.stringify(COST)};
  if (cmd === "get_rightsizing") return ${JSON.stringify(RIGHTSIZING)};
  if (cmd === "apply_yaml") { window.__applied = args; return "ok"; }
  if (cmd === "discover_crds") return [];
}`);

test("shows requests vs recommendations and applies only the changed container", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /^Cost/ }).first().click();
  await page.locator('[data-testid="cost-mode-rightsizing"]').click();
  const panel = page.locator('[data-testid="rightsizing"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="rightsizing-saving"]')).toContainText("$61");

  const rows = panel.locator('[data-testid="rightsizing-row"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("web");
  await expect(rows.nth(0)).toContainText("over-provisioned");
  await expect(rows.nth(0)).toContainText("+$61");
  await expect(rows.nth(1)).toContainText("under-provisioned");
  await expect(rows.nth(1)).toContainText("−$9");

  await panel.locator('[data-testid="rightsizing-filter-under"]').click();
  await expect(rows).toHaveCount(1);
  await panel.locator('[data-testid="rightsizing-filter-all"]').click();

  // Expand web: the per-container table shows both containers.
  await rows.nth(0).getByRole("button", { name: "Expand" }).click();
  await expect(panel).toContainText("sidecar");

  // Apply: the patch names only the over-provisioned container.
  await rows.nth(0).locator('[data-testid="rightsizing-apply"]').click();
  const patch = page.locator('[data-testid="rightsizing-patch"]');
  await expect(patch).toContainText("kind: Deployment");
  await expect(patch).toContainText("name: app");
  await expect(patch).toContainText("cpu: 200m");
  await expect(patch).toContainText("memory: 320Mi");
  await expect(patch).not.toContainText("sidecar");
  await page.locator('[data-testid="rightsizing-confirm"]').click();
  await expect(page.getByText("Requests updated")).toBeVisible();
  const applied = await page.evaluate(() => (window as unknown as { __applied: { yaml: string } }).__applied);
  expect(applied.yaml).toContain("namespace: shop");
  expect(applied.yaml).toContain("cpu: 200m");
});
