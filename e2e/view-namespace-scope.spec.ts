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
  }`)})(cmd, args);
}`;

const VIEWS = [
  { sidebar: /^Helm Releases/, cmd: "list_helm_releases" },
  { sidebar: /^Cost/, cmd: "get_cost_overview" },
  { sidebar: /^Topology/, cmd: "get_namespace_topology" },
];

for (const view of VIEWS) {
  test(`picking a namespace in the header reloads ${view.cmd}`, async ({ page, mockInvoke }) => {
    await mockInvoke(MOCK);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

    const calls = () =>
      page.evaluate((cmd) => ((window as unknown as { __calls: { cmd: string; namespace: unknown }[] }).__calls ?? []).filter((c) => c.cmd === cmd).map((c) => c.namespace), view.cmd);

    await page.getByRole("button", { name: view.sidebar }).first().click();
    await expect.poll(calls).toEqual(["default"]);

    await selectNamespace(page, "shop");
    await expect.poll(calls).toEqual(["default", "shop"]);
  });
}
