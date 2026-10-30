/**
 * The namespace picker in an app view's header scopes that view: picking a
 * namespace reloads the view's data for it (openAppView issued the entry
 * load, so the entry itself is not loaded twice).
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";
import { selectNamespace } from "./helpers";

const NOW = new Date().toISOString();
const COST = { namespaces: [], cluster_cost_hourly: 0, cluster_cost_monthly: 0, total_cpu_cores: 0, total_memory_gb: 0, cpu_rate_per_core_hour: 0.0325, memory_rate_per_gb_hour: 0.0044, source: "fallback", fetched_at: NOW };
const TOPOLOGY = { nodes: [], edges: [], total_resources: 0, clustered: false, has_cycles: false };
const RIGHTSIZING = { scope: "namespace", namespace: null, usage_source: "metrics-server", usage_window: "now", cpu_rate_per_core_hour: 0.0325, memory_rate_per_gb_hour: 0.0044, total_saving_monthly: 0, over_count: 0, under_count: 0, fetched_at: NOW, workloads: [] };
const SECURITY = { pods: [], total_vulns: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, total_images_scanned: 0, compliant_pods: 0, non_compliant_pods: 0, scanner: "none", fetched_at: NOW };
const SUBJECTS = [{ kind: "User", name: "alice", namespace: null, bindings: 1 }];
const PERMS = { subject: { kind: "User", name: "alice", namespace: null }, groups: ["system:authenticated"], grants: [], rows: [], cluster_admin: false, missing_roles: [] };

// Every view command records its args, so the test can assert what was asked.
const MOCK = `(cmd, args) => {
  if (cmd === "get_namespaces") return ["default", "shop"];
  window.__calls = window.__calls || [];
  window.__calls.push({ cmd, namespace: args.namespace });
  return (${clusterBootMock(`(cmd, args) => {
    if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
    if (cmd === "discover_crds") return [];
    if (cmd === "list_helm_releases") return [];
    if (cmd === "get_cost_overview") return ${JSON.stringify(COST)};
    if (cmd === "get_namespace_topology") return ${JSON.stringify(TOPOLOGY)};
    if (cmd === "get_rightsizing") return ${JSON.stringify(RIGHTSIZING)};
    if (cmd === "get_security_overview") return ${JSON.stringify(SECURITY)};
    if (cmd === "get_rbac_subjects") return ${JSON.stringify(SUBJECTS)};
    if (cmd === "get_effective_permissions") return ${JSON.stringify(PERMS)};
  }`)})(cmd, args);
}`;

const VIEWS = [
  { sidebar: /^Helm Releases/, cmd: "list_helm_releases" },
  { sidebar: /^Cost/, cmd: "get_cost_overview" },
  { sidebar: /^Topology/, cmd: "get_namespace_topology" },
];

type Page = import("@playwright/test").Page;

async function boot(page: Page, mockInvoke: (mock: string) => Promise<void>) {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
}

function callsOf(page: Page, cmd: string) {
  return () =>
    page.evaluate((c) => ((window as unknown as { __calls: { cmd: string; namespace: unknown }[] }).__calls ?? []).filter((x) => x.cmd === c).map((x) => x.namespace), cmd);
}

for (const view of VIEWS) {
  test(`picking a namespace in the header reloads ${view.cmd}`, async ({ page, mockInvoke }) => {
    await boot(page, mockInvoke);
    const calls = callsOf(page, view.cmd);

    await page.getByRole("button", { name: view.sidebar }).first().click();
    await expect.poll(calls).toEqual(["default"]);

    await selectNamespace(page, "shop");
    await expect.poll(calls).toEqual(["default", "shop"]);
  });
}

// A namespace change reloads only the mode on screen and drops the other one,
// so going back to that mode must load it for the new namespace instead of
// showing an empty state.
test("Costs reloads for the new namespace after a change made in Rightsizing", async ({ page, mockInvoke }) => {
  await boot(page, mockInvoke);
  await page.getByRole("button", { name: /^Cost/ }).first().click();
  await expect.poll(callsOf(page, "get_cost_overview")).toEqual(["default"]);

  await page.locator('[data-testid="cost-mode-rightsizing"]').click();
  await selectNamespace(page, "shop");
  await expect.poll(callsOf(page, "get_rightsizing")).toEqual(["default", "shop"]);

  await page.getByRole("radio", { name: "Costs" }).click();
  await expect.poll(callsOf(page, "get_cost_overview")).toEqual(["default", "shop"]);
  await expect(page.getByText("No cost data available")).toHaveCount(0);
});

test("Posture reloads for the new namespace after a change made in Permissions", async ({ page, mockInvoke }) => {
  await boot(page, mockInvoke);
  await page.getByRole("button", { name: /^Security/ }).first().click();
  await expect.poll(callsOf(page, "get_security_overview")).toEqual(["default"]);

  await page.locator('[data-testid="security-mode-permissions"]').click();
  await selectNamespace(page, "shop");
  await expect.poll(callsOf(page, "get_rbac_subjects")).toEqual(["default", "shop"]);

  await page.getByRole("radio", { name: "Posture" }).click();
  await expect.poll(callsOf(page, "get_security_overview")).toEqual(["default", "shop"]);
  await expect(page.getByText("No security data available")).toHaveCount(0);
});

test("a namespace change drops the RBAC subject picked in the old namespace", async ({ page, mockInvoke }) => {
  await boot(page, mockInvoke);
  await page.getByRole("button", { name: /^Security/ }).first().click();
  await page.locator('[data-testid="security-mode-permissions"]').click();
  const panel = page.locator('[data-testid="rbac"]');
  await panel.locator('[data-testid="rbac-subject"]').filter({ hasText: "alice" }).click();
  await expect(panel.locator('[data-testid="rbac-summary"]')).toBeVisible();

  await selectNamespace(page, "shop");
  await expect(panel.getByText(/Pick a subject/)).toBeVisible();
});
