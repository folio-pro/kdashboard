import { test as base, type Page } from "@playwright/test";
import { installMockInvoke } from "./fixtures/mocked-cluster";
import { MOCK_CONFIGMAPS_LIST, MOCK_DEPLOYMENTS_LIST, MOCK_PODS_LIST, MOCK_SERVICES_LIST } from "./fixtures/mock-k8s";

export { expect } from "@playwright/test";

/**
 * The default e2e backend: a small, healthy mock cluster (the lists in
 * fixtures/mock-k8s) answering the commands the app issues on boot and when
 * a table or detail view opens. `bun run dev` has no window.electronAPI at
 * all, so without this every invoke() rejects and no table ever renders.
 * Specs that need a specific cluster state use the `mockInvoke` fixture
 * from fixtures/mocked-cluster instead.
 */
const DEFAULT_CLUSTER = `(cmd, args) => {
  const lists = ${JSON.stringify({
    pods: MOCK_PODS_LIST,
    deployments: MOCK_DEPLOYMENTS_LIST,
    services: MOCK_SERVICES_LIST,
    configmaps: MOCK_CONFIGMAPS_LIST,
  })};
  const inNamespace = (items) => (args && args.namespace ? items.filter((i) => i.metadata.namespace === args.namespace) : items);
  if (cmd === "get_contexts") return ["mock-cluster"];
  if (cmd === "get_current_context") return "mock-cluster";
  if (cmd === "get_namespaces") return ["default", "kube-system"];
  if (cmd === "get_resource_counts") return {};
  if (cmd === "bench_config") return { enabled: false };
  if (cmd === "discover_crds") return [];
  if (cmd === "list_resources") {
    const list = lists[args.resourceType];
    return list ? { resource_type: list.resource_type, items: inNamespace(list.items) } : { resource_type: args.resourceType, items: [] };
  }
  if (cmd === "list_pods_by_selector") return { resource_type: "pods", items: inNamespace(lists.pods.items) };
  if (cmd === "get_resource") {
    const all = Object.values(lists).flatMap((l) => l.items);
    return all.find((i) => i.metadata.name === args.name && (!args.namespace || i.metadata.namespace === args.namespace)) ?? null;
  }
  if (cmd === "get_resource_events") return [];
  if (cmd === "get_pod_metrics") return { available: false, reason: "mock cluster", pods: [] };
  return null;
}`;

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await installMockInvoke(page, DEFAULT_CLUSTER);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await use(page);
  },
});

export async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(300);
}

/** The rows of the active resource table. */
export function tableRows(page: Page) {
  return page.locator('[data-testid="resource-row"]');
}

/** Open the namespace picker and choose one. */
export async function selectNamespace(page: Page, namespace: string): Promise<void> {
  // The popover trigger and the button inside it both carry the label.
  await page.getByRole("button", { name: "Change namespace" }).last().click();
  await page.getByRole("button", { name: namespace, exact: true }).click();
}
