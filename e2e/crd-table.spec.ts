/**
 * CRD table tabs. Every `crd-table` tab shares one CrdTableView instance, so
 * the open detail has to live on the Tab (#81), and it has to be looked up in
 * the live listing rather than snapshotted at click time (#82).
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const MOCK = clusterBootMock(`(cmd, args) => {
  const crd = (kind, plural) => ({ group: "example.com", version: "v1", kind, plural, scope: "Namespaced", short_names: [] });
  const item = (kind, name, phase) => ({
    kind, api_version: "example.com/v1",
    metadata: { name, namespace: "default", uid: kind + "-" + name, creation_timestamp: "2026-01-01T00:00:00Z" },
    spec: {}, status: { phase },
  });
  if (cmd === "discover_crds") return [{ group: "example.com", resources: [crd("Widget", "widgets"), crd("Gadget", "gadgets")] }];
  // Every requested kind must be answered: the sidebar re-requests a missing
  // count, which against a synchronous mock never yields the main thread.
  if (cmd === "get_crd_counts") return { "example.com/Widget": 2, "example.com/Gadget": 1 };
  if (cmd === "list_crd_resources") {
    const items = args.kind === "Widget"
      ? [item("Widget", "widget-a", "Pending"), item("Widget", "widget-b", "Pending")]
      : [item("Gadget", "gadget-a", "Pending")];
    return { items, columns: [{ name: "Phase", json_path: ".status.phase", column_type: "string", description: "" }] };
  }
}`);

async function openCrd(page: import("@playwright/test").Page, kind: string) {
  await page.locator("aside").getByRole("button", { name: kind, exact: true }).click();
  await expect(page.getByRole("cell", { name: `${kind.toLowerCase()}-a`, exact: true })).toBeVisible();
}

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
});

test("each CRD tab keeps its own detail (#81)", async ({ page }) => {
  await openCrd(page, "Widget");
  await page.getByRole("cell", { name: "widget-a", exact: true }).click();
  const back = page.getByRole("button", { name: "Back" });
  await expect(back).toBeVisible();

  await openCrd(page, "Gadget");
  await expect(back).toHaveCount(0);
  await expect(page.getByText("widget-a")).toHaveCount(0);

  await page.getByRole("tab", { name: /Widget/ }).click();
  await expect(back).toBeVisible();
  await expect(page.getByText("widget-a").first()).toBeVisible();

  await page.getByRole("tab", { name: /Gadget/ }).click();
  await expect(back).toHaveCount(0);
});

test("the CRD detail follows watch updates and flags a deletion (#82)", async ({ page }) => {
  await openCrd(page, "Widget");
  await page.getByRole("cell", { name: "widget-a", exact: true }).click();
  await expect(page.getByText("Pending").first()).toBeVisible();

  const replace = (source: string) =>
    page.evaluate((src) => {
      const { k8sStore } = (window as any).__kdash;
      const items = (0, eval)(src)(k8sStore.crdResources.items);
      k8sStore._replaceResources({ items, resource_type: k8sStore.selectedResourceType }, Date.now());
    }, source);

  await replace(`(items) => items.map((r) => r.metadata.name === "widget-a" ? { ...r, status: { phase: "Ready" } } : r)`);
  await expect(page.getByText("Ready").first()).toBeVisible();
  await expect(page.getByText("Pending")).toHaveCount(0);

  await replace(`(items) => items.filter((r) => r.metadata.name !== "widget-a")`);
  await expect(page.getByRole("status").filter({ hasText: "no longer exists" })).toBeVisible();
});
