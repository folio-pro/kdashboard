/**
 * Topology → Policies: overlay NetworkPolicy isolation badges and allowed
 * flows on the graph, with a side panel summarising the namespace.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";
import { MOCK_TOPOLOGY_GRAPH } from "./fixtures/mock-k8s";

const NETPOL = {
  namespace: "default", policy_count: 2, default_deny_ingress: true, default_deny_egress: false,
  policies: [
    { name: "default-deny", policy_types: ["Ingress"], selects: ["Deployment/api-server"], pod_count: 2, selects_all: true, ingress_rules: 0, egress_rules: 0 },
    { name: "orphan", policy_types: ["Ingress"], selects: [], pod_count: 0, selects_all: false, ingress_rules: 1, egress_rules: 0 },
  ],
  workloads: [
    { kind: "Deployment", name: "api-server", pod_count: 2, isolated_ingress: true, isolated_egress: false, policies: ["default-deny"], allowed_from: { any: false, workloads: [], namespaces: ["monitoring"], cidrs: [], ports: ["8080"] }, allowed_to: { any: false, workloads: [], namespaces: [], cidrs: [], ports: [] } },
  ],
  flows: [],
  fetched_at: "",
};

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "get_namespace_topology") return ${JSON.stringify(MOCK_TOPOLOGY_GRAPH)};
  if (cmd === "get_network_policies") { window.__npArgs = args; return ${JSON.stringify(NETPOL)}; }
  if (cmd === "discover_crds") return [];
}`);

test("the Policies layer badges workloads and explains the selected one", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Topology/ }).first().click();
  await expect(page.locator('[data-testid="topology-policies"]')).toBeVisible();

  await page.locator('[data-testid="topology-policies"]').click();
  const panel = page.locator('[data-testid="netpol-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("default-deny ingress");
  await expect(panel).toContainText("egress open by default");
  await expect(panel.locator('[data-testid="netpol-policy"]')).toHaveCount(2);
  await expect(panel).toContainText("selects nothing");
  const args = await page.evaluate(() => (window as unknown as { __npArgs: unknown }).__npArgs);
  expect(args).toEqual({ namespace: "default" });

  // The Deployment and its pods carry a "partial" badge (ingress only).
  const badges = page.locator('[data-testid="netpol-badge"]');
  await expect(badges.first()).toBeVisible();
  expect(await badges.evaluateAll((els) => els.map((e) => e.getAttribute("data-badge")))).toContain("partial");

  // Clicking the deployment explains what may reach it.
  await page.locator("svg text", { hasText: "api-server" }).first().click();
  await expect(panel.locator('[data-testid="netpol-selected"]')).toContainText("Deployment/api-server");
  await expect(panel.locator('[data-testid="netpol-selected"]')).toContainText("from ns monitoring on 8080");
});
