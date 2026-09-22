/**
 * CRD table tabs. Every `crd-table` tab shares one CrdTableView instance, so
 * the open detail has to live on the Tab (#81), and it has to be looked up in
 * the live listing rather than snapshotted at click time (#82). The table
 * itself matches the built-in ones: error state, keyboard, filter, sort and a
 * row menu (#84).
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";
import type { Page } from "@playwright/test";

const MOCK = clusterBootMock(`(cmd, args) => {
  window.__calls = window.__calls ?? [];
  window.__calls.push({ cmd, args });
  const crd = (kind, plural) => ({ group: "example.com", version: "v1", kind, plural, scope: "Namespaced", short_names: [] });
  const item = (kind, name, phase, replicas) => ({
    kind, api_version: "example.com/v1",
    metadata: { name, namespace: "default", uid: kind + "-" + name, creation_timestamp: "2026-01-01T00:00:00Z" },
    spec: { replicas }, status: { phase },
  });
  if (cmd === "discover_crds") {
    return [{ group: "example.com", resources: [crd("Widget", "widgets"), crd("Gadget", "gadgets"), crd("Broken", "brokens")] }];
  }
  // Every requested kind must be answered: the sidebar re-requests a missing
  // count, which against a synchronous mock never yields the main thread.
  if (cmd === "get_crd_counts") return { "example.com/Widget": 3, "example.com/Gadget": 1, "example.com/Broken": 0 };
  if (cmd === "list_crd_resources") {
    if (args.kind === "Broken") throw new Error("brokens.example.com is forbidden: User cannot list resource");
    const items = args.kind === "Widget"
      ? [item("Widget", "widget-a", "Pending", 2), item("Widget", "widget-b", "Pending", 10), item("Widget", "widget-c", "Ready", 1)]
      : [item("Gadget", "gadget-a", "Pending", 1)];
    return {
      items,
      columns: [
        { name: "Phase", json_path: ".status.phase", column_type: "string", description: "" },
        { name: "Replicas", json_path: ".spec.replicas", column_type: "integer", description: "" },
      ],
    };
  }
  if (cmd === "delete_resource") return null;
}`);

const rows = (page: Page) => page.getByTestId("crd-row");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const names = (page: Page) => rows(page).locator("td:nth-child(2)").allTextContents();

async function openCrd(page: Page, kind: string) {
  await page.locator("aside").getByRole("button", { name: kind, exact: true }).click();
  await expect(row(page, `${kind.toLowerCase()}-a`)).toBeVisible();
}

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
});

test("each CRD tab keeps its own detail (#81)", async ({ page }) => {
  await openCrd(page, "Widget");
  await row(page, "widget-a").click();
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
  await row(page, "widget-a").click();
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

test("a failed CRD list shows an error with Retry, not an empty table (#84)", async ({ page }) => {
  await page.locator("aside").getByRole("button", { name: "Broken", exact: true }).click();
  const error = page.getByTestId("table-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("data-error-kind", "forbidden");
  await expect(page.getByText(/No brokens found/i)).toHaveCount(0);

  const lists = () => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "list_crd_resources" && c.args.kind === "Broken").length);
  const before = await lists();
  await error.getByRole("button", { name: "Retry" }).click();
  await expect.poll(lists).toBeGreaterThan(before);
});

test("rows are keyboard operable: j/k move, Enter opens, Esc returns (#84)", async ({ page }) => {
  await openCrd(page, "Widget");
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("j");
  await expect(row(page, "widget-a")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "widget-a")).toBeFocused();
  await page.keyboard.press("j");
  await expect(row(page, "widget-b")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "widget-b")).toHaveAttribute("tabindex", "0");
  await expect(row(page, "widget-a")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("k");
  await expect(row(page, "widget-a")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
  await expect(row(page, "widget-a")).toBeVisible();
});

test("/ focuses the filter, which narrows rows by name or column value (#84)", async ({ page }) => {
  await openCrd(page, "Widget");
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("/");
  const filter = page.locator("#resource-filter");
  await expect(filter).toBeFocused();
  await filter.fill("ready");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "widget-c")).toBeVisible();
  await filter.fill("widget-b");
  await expect(rows(page)).toHaveCount(1);
  await filter.fill("");
  await expect(rows(page)).toHaveCount(3);
});

test("headers sort, numerically for numeric printer columns (#84)", async ({ page }) => {
  await openCrd(page, "Widget");
  await expect.poll(() => names(page)).toEqual(["widget-a", "widget-b", "widget-c"]);
  await page.getByTestId("header-name").click();
  await expect.poll(() => names(page)).toEqual(["widget-c", "widget-b", "widget-a"]);
  await page.getByRole("button", { name: "Replicas" }).click();
  await expect.poll(() => names(page)).toEqual(["widget-c", "widget-a", "widget-b"]);
});

test("right-click offers YAML, Copy name and Delete; Delete confirms and deletes (#84)", async ({ page }) => {
  await openCrd(page, "Widget");
  await row(page, "widget-b").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy name", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy as YAML" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete widget-b" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__calls.find((c: any) => c.cmd === "delete_resource")?.args))
    .toMatchObject({ kind: "Widget", apiVersion: "example.com/v1", name: "widget-b", namespace: "default" });
});
