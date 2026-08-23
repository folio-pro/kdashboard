/**
 * The resource table against the default mock cluster (see helpers.ts): rows,
 * headers, the search box, sorting, namespace scoping, row preview and bulk
 * selection. Pods is the view the app boots into.
 */
import { test, expect, tableRows, selectNamespace } from "./helpers";
import { MOCK_PODS_LIST } from "./fixtures/mock-k8s";

// The app boots scoped to the "default" namespace.
const POD_NAMES = MOCK_PODS_LIST.items.filter((p) => p.metadata.namespace === "default").map((p) => p.metadata.name);

test.describe("ResourceTable", () => {
  test("renders one row per pod with name and status", async ({ page }) => {
    const rows = tableRows(page);
    await expect(rows).toHaveCount(POD_NAMES.length);
    await expect(rows.first().locator('[data-testid="cell-name"]')).toBeVisible();
    // Status is the effective state derived from the container statuses.
    await expect(rows.first().locator('[data-testid="cell-status"]')).toHaveText(/Running/);
  });

  test("shows the column headers for pods", async ({ page }) => {
    const headers = page.locator('[data-testid="table-header"]');
    await expect(headers.first()).toBeVisible();
    await expect(headers.filter({ hasText: /^Name/ })).toHaveCount(1);
    await expect(headers.filter({ hasText: /^Status/ })).toHaveCount(1);
    await expect(headers.filter({ hasText: /^Ready/ })).toHaveCount(1);
  });

  test("filters rows by name and clears", async ({ page }) => {
    const search = page.locator("#resource-filter");
    await search.fill("api");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(tableRows(page).first().locator('[data-testid="cell-name"]')).toContainText("api-server-v2");
    await search.fill("");
    await expect(tableRows(page)).toHaveCount(POD_NAMES.length);
  });

  test("a typed facet narrows by status", async ({ page }) => {
    const search = page.locator("#resource-filter");
    await search.fill("status:running ");
    await expect(tableRows(page)).toHaveCount(POD_NAMES.length);
    await search.fill("status:crash ");
    await expect(tableRows(page)).toHaveCount(0);
  });

  test.describe("Sorting", () => {
    test("clicking Name toggles ascending and descending", async ({ page }) => {
      const names = async () => (await tableRows(page).locator('[data-testid="cell-name"]').allTextContents()).map((n) => n.trim());
      const sorted = [...POD_NAMES].sort();
      const header = page.locator('[data-testid="header-name"]');
      // Whatever the boot order, one click per direction.
      await header.click();
      const first = await names();
      const ascendingFirst = first[0] === sorted[0];
      expect(first).toEqual(ascendingFirst ? sorted : [...sorted].reverse());
      await header.click();
      expect(await names()).toEqual(ascendingFirst ? [...sorted].reverse() : sorted);
    });
  });

  test.describe("Namespace scoping", () => {
    test("one namespace hides the column and the other namespaces' rows", async ({ page }) => {
      await selectNamespace(page, "kube-system");
      await expect(tableRows(page)).toHaveCount(1);
      await expect(tableRows(page).first().locator('[data-testid="cell-name"]')).toContainText("cache-redis");
      await expect(page.getByText("Namespace column hidden")).toBeVisible();
      await selectNamespace(page, "default");
      await expect(tableRows(page)).toHaveCount(POD_NAMES.length);
    });
  });

  test.describe("Selection", () => {
    test("click previews the row in the docked detail panel", async ({ page }) => {
      const first = tableRows(page).first();
      const name = await first.locator('[data-testid="cell-name"]').textContent();
      await first.click();
      const panel = page.locator('[data-testid="detail-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel.locator('[data-testid="detail-resource-name"]')).toHaveText(name?.trim() ?? "");
      // Escape closes the preview.
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    });

    test("double click opens the row in its own tab", async ({ page }) => {
      const first = tableRows(page).first();
      const name = (await first.locator('[data-testid="cell-name"]').textContent())?.trim() ?? "";
      await first.dblclick();
      await expect(page.locator('[data-testid="detail-panel"] [data-testid="detail-resource-name"]')).toHaveText(name);
      // The table is gone: the tab shows the page variant with labelled actions.
      await expect(page.getByRole("button", { name: "Shell", exact: true }).first()).toBeVisible();
    });
  });

  test.describe("Bulk selection", () => {
    test("checking rows shows the bulk action bar with the count", async ({ page }) => {
      // The checkbox mounts when the pointer reaches the row (it is hover-only
      // chrome until a selection exists), so hover before clicking.
      await tableRows(page).nth(0).hover();
      await tableRows(page).nth(0).locator('[data-testid="row-checkbox"]').click({ force: true });
      await expect(page.getByText("1 resource selected")).toBeVisible();
      await tableRows(page).nth(1).hover();
      await tableRows(page).nth(1).locator('[data-testid="row-checkbox"]').click({ force: true });
      await expect(page.getByText("2 resources selected")).toBeVisible();
    });

    test("the header checkbox selects every visible row", async ({ page }) => {
      await page.locator('[data-testid="select-all-checkbox"]').click({ force: true });
      await expect(page.getByText(`${POD_NAMES.length} resources selected`)).toBeVisible();
    });
  });
});
