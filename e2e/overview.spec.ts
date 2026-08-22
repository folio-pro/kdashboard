/**
 * Overview and Problems: the cluster summary tiles, node capacity bars and
 * the problem list with its detail/diagnosis aside, fed by get_cluster_overview.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const since = new Date(Date.now() - 38 * 60_000).toISOString();

const OVERVIEW = {
  scope: "cluster",
  namespace: null,
  nodes: [
    { name: "ip-10-0-1-12", ready: true, pressure: ["MemoryPressure"], unschedulable: false, instance_type: "m6i.xlarge", zone: "eu-west-1a", kubelet_version: "v1.31.2", cpu_allocatable: 4, memory_allocatable: 16 * 1024 ** 3, cpu_requests: 3.4, memory_requests: 14.7 * 1024 ** 3, pod_count: 38, cpu_usage: 2.1, memory_usage: 12 * 1024 ** 3, age: since },
    { name: "ip-10-0-2-08", ready: true, pressure: [], unschedulable: false, instance_type: "m6i.xlarge", zone: "eu-west-1b", kubelet_version: "v1.31.2", cpu_allocatable: 4, memory_allocatable: 16 * 1024 ** 3, cpu_requests: 1.9, memory_requests: 6 * 1024 ** 3, pod_count: 21, cpu_usage: null, memory_usage: null, age: since },
  ],
  pods: { running: 284, pending: 9, succeeded: 15, failed: 4, unknown: 0, total: 312 },
  problems: [
    { id: "Pod/billing/payments-api-7f9c-x2k", severity: "critical", kind: "Pod", name: "payments-api-7f9c-x2k", namespace: "billing", reason: "CrashLoopBackOff", detail: "container api — back-off 5m", owner: "Deployment/payments-api", since, restarts: 14, ready: null, desired: null },
    { id: "Deployment/storefront/checkout-web", severity: "warning", kind: "Deployment", name: "checkout-web", namespace: "storefront", reason: "4/6 ready", detail: null, owner: null, since, restarts: 0, ready: 4, desired: 6 },
    { id: "Node//ip-10-0-1-12", severity: "warning", kind: "Node", name: "ip-10-0-1-12", namespace: null, reason: "MemoryPressure", detail: null, owner: null, since: null, restarts: 0, ready: null, desired: null },
  ],
  warnings: [
    { reason: "BackOff", message: "Back-off restarting failed container api", kind: "Pod", name: "payments-api-7f9c-x2k", namespace: "billing", count: 14, last_timestamp: since },
    { reason: "Unhealthy", message: "Readiness probe failed: 503", kind: "Pod", name: "checkout-web-5d8-q91", namespace: "storefront", count: 3, last_timestamp: since },
  ],
  warnings_total: 17,
  top_pods_cpu: [{ name: "kafka-0", namespace: "messaging", cpu_usage: 1.92, memory_usage: 3 * 1024 ** 3 }],
  top_pods_memory: [{ name: "kafka-0", namespace: "messaging", cpu_usage: 1.92, memory_usage: 3 * 1024 ** 3 }],
  metrics_available: true,
  partial: [],
  fetched_at: new Date().toISOString(),
};

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "get_cluster_overview") { window.__overviewArgs = args; return ${JSON.stringify(OVERVIEW)}; }
  if (cmd === "diagnose_resource") return { resource_uid: "u", resource_kind: args.kind, resource_name: args.name, health: "unhealthy", checked_at: "", issues: [{ severity: "critical", category: "container", title: "Container api keeps crashing", detail: "Exit code 1 fourteen times", suggestion: "Check the container logs for the startup error" }] };
  if (cmd === "discover_crds") return [];
}`);

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
});

test("the Overview shows tiles, node pressure and the top problems", async ({ page }) => {
  await page.getByRole("button", { name: /^Overview/ }).first().click();
  const view = page.locator('[data-testid="overview"]');
  await expect(view).toBeVisible();

  const tiles = view.locator('[data-testid="overview-tile"]');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0)).toContainText("2/2");
  await expect(tiles.nth(0)).toContainText("1 under pressure");
  await expect(tiles.nth(1)).toContainText("312");
  await expect(tiles.nth(1)).toContainText("284 Running · 9 Pending · 4 Failed");
  await expect(tiles.nth(2)).toContainText("3");
  await expect(tiles.nth(2)).toContainText("1 critical · 2 warning");
  await expect(tiles.nth(3)).toContainText("17");

  const nodes = view.locator('[data-testid="overview-nodes"]');
  await expect(nodes).toContainText("ip-10-0-1-12");
  await expect(nodes).toContainText("MemoryPressure");
  await expect(nodes).toContainText("85 %");
  await expect(nodes).toContainText("38 pods");

  const problems = view.locator('[data-testid="overview-problems"]');
  await expect(problems).toContainText("payments-api-7f9c-x2k");
  await expect(problems).toContainText("CrashLoopBackOff");
  await expect(view.locator('[data-testid="overview-warnings"]')).toContainText("Readiness probe failed: 503");
  await expect(view.locator('[data-testid="overview-top"]')).toContainText("kafka-0");

  // The overview is loaded for the current namespace as a fallback scope.
  const args = await page.evaluate(() => (window as unknown as { __overviewArgs: unknown }).__overviewArgs);
  expect(args).toEqual({ namespace: "default" });

  // Jump to the full problem list.
  await problems.getByRole("button", { name: /Open problems/ }).click();
  await expect(page.locator('[data-testid="problems"]')).toBeVisible();
});

test("the Problems view filters, selects and diagnoses", async ({ page }) => {
  await page.getByRole("button", { name: /^Problems/ }).first().click();
  const view = page.locator('[data-testid="problems"]');
  await expect(view).toBeVisible();
  const rows = view.locator('[data-testid="problem-row"]');
  await expect(rows).toHaveCount(3);

  // First row is selected by default and diagnosed.
  const detail = view.locator('[data-testid="problem-detail"]');
  await expect(detail).toContainText("payments-api-7f9c-x2k");
  await expect(detail).toContainText("14 restarts");
  await expect(detail.locator('[data-testid="problem-diagnosis"]')).toContainText("Container api keeps crashing");
  await expect(detail.getByRole("button", { name: "Logs" })).toBeVisible();
  await expect(detail.getByRole("button", { name: /Restart deployment/ })).toBeVisible();

  // Filter by severity.
  await view.locator('[data-testid="filter-warning"]').click();
  await expect(rows).toHaveCount(2);
  await expect(detail).toContainText("checkout-web");
  await expect(detail).toContainText("4/6 ready");

  // Free text narrows further; node problems have no namespace.
  await view.getByLabel("Filter problems").fill("pressure");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("cluster");
});
