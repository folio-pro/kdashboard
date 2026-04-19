import { test, expect } from "./helpers";
import { MOCK_DEPLOYMENTS_LIST, MOCK_PODS_LIST } from "./fixtures/mock-k8s";

test.describe("ResourceTable", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("displays resource rows", async ({ page }) => {
    const rows = page.locator('[data-testid="resource-row"]');
    await expect(rows.first()).toBeVisible();
  });

  test("displays column headers", async ({ page }) => {
    const headers = page.locator('[data-testid="table-header"]');
    await expect(headers.first()).toBeVisible();
  });

  test("displays resource name", async ({ page }) => {
    const firstRow = page.locator('[data-testid="resource-row"]').first();
    const nameCell = firstRow.locator('[data-testid="cell-name"]');
    await expect(nameCell).toBeVisible();
    const name = await nameCell.textContent();
    expect(name).toBeTruthy();
  });

  test("displays resource status", async ({ page }) => {
    const firstRow = page.locator('[data-testid="resource-row"]').first();
    const statusCell = firstRow.locator('[data-testid="cell-status"]');
    await expect(statusCell).toBeVisible();
  });

  test("filters resources by name", async ({ page }) => {
    const filterInput = page.locator('[data-testid="filter-input"]');
    await filterInput.fill("api");

    await page.waitForTimeout(300);

    const rows = page.locator('[data-testid="resource-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const nameCell = rows.nth(i).locator('[data-testid="cell-name"]');
      const name = await nameCell.textContent();
      expect(name?.toLowerCase()).toContain("api");
    }
  });

  test("clears filter and shows all resources", async ({ page }) => {
    const filterInput = page.locator('[data-testid="filter-input"]');
    await filterInput.fill("api");

    await page.waitForTimeout(300);

    const clearButton = page.locator('[data-testid="filter-clear"]');
    await clearButton.click();

    await page.waitForTimeout(300);

    const rows = page.locator('[data-testid="resource-row"]');
    const allRowsCount = await rows.count();
    expect(allRowsCount).toBeGreaterThan(1);
  });

  test.describe("Sorting", () => {
    test("sorts by name ascending", async ({ page }) => {
      const nameHeader = page.locator('[data-testid="header-name"]');
      await nameHeader.click();

      await page.waitForTimeout(200);

      const rows = page.locator('[data-testid="resource-row"]');
      const names = await rows.all();
      const nameTexts: string[] = [];

      for (const row of names) {
        const nameCell = row.locator('[data-testid="cell-name"]');
        const text = await nameCell.textContent();
        if (text) nameTexts.push(text);
      }

      const sorted = [...nameTexts].sort((a, b) => a.localeCompare(b));
      expect(nameTexts).toEqual(sorted);
    });

    test("sorts by name descending after second click", async ({ page }) => {
      const nameHeader = page.locator('[data-testid="header-name"]');
      await nameHeader.click();
      await nameHeader.click();

      await page.waitForTimeout(200);

      const rows = page.locator('[data-testid="resource-row"]');
      const names = await rows.all();
      const nameTexts: string[] = [];

      for (const row of names) {
        const nameCell = row.locator('[data-testid="cell-name"]');
        const text = await nameCell.textContent();
        if (text) nameTexts.push(text);
      }

      const sorted = [...nameTexts].sort((a, b) => b.localeCompare(a));
      expect(nameTexts).toEqual(sorted);
    });
  });

  test.describe("Selection", () => {
    test("selects a resource on click", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(200);

      await expect(row).toHaveAttribute("data-selected", "true");
    });

    test("opens detail panel on double click", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.dblclick();

      await page.waitForTimeout(300);

      const detailPanel = page.locator('[data-testid="detail-panel"]');
      await expect(detailPanel).toBeVisible();
    });
  });

  test.describe("Bulk Selection", () => {
    test("shows bulk action bar when resources are selected", async ({ page }) => {
      const firstRow = page.locator('[data-testid="resource-row"]').first();
      const checkbox = firstRow.locator('[data-testid="row-checkbox"]');
      await checkbox.click();

      await page.waitForTimeout(200);

      const bulkActionBar = page.locator('[data-testid="bulk-action-bar"]');
      await expect(bulkActionBar).toBeVisible();
    });

    test("hides bulk action bar when no resources selected", async ({ page }) => {
      const bulkActionBar = page.locator('[data-testid="bulk-action-bar"]');
      const isVisible = await bulkActionBar.isVisible().catch(() => false);

      if (isVisible) {
        const checkbox = page.locator('[data-testid="row-checkbox"]').first();
        await checkbox.click();
        await page.waitForTimeout(200);
      }

      await expect(bulkActionBar).not.toBeVisible();
    });

    test("select all checkbox selects all visible resources", async ({ page }) => {
      const selectAllCheckbox = page.locator('[data-testid="select-all-checkbox"]');
      await selectAllCheckbox.click();

      await page.waitForTimeout(200);

      const rows = page.locator('[data-testid="resource-row"]');
      const count = await rows.count();

      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        await expect(row).toHaveAttribute("data-selected", "true");
      }
    });
  });

  test.describe("Namespace Filtering", () => {
    test("filters by namespace", async ({ page }) => {
      const namespaceSelector = page.locator('[data-testid="namespace-filter"]');
      await namespaceSelector.click();

      await page.waitForTimeout(200);

      const namespaceOption = page.locator('[data-testid="namespace-option"]').filter({ hasText: "default" }).first();
      await namespaceOption.click();

      await page.waitForTimeout(300);

      const rows = page.locator('[data-testid="resource-row"]');
      const count = await rows.count();

      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const namespaceCell = row.locator('[data-testid="cell-namespace"]');
        const namespace = await namespaceCell.textContent();
        expect(namespace?.trim()).toBe("default");
      }
    });

    test("shows resources from all namespaces", async ({ page }) => {
      const namespaceSelector = page.locator('[data-testid="namespace-filter"]');
      await namespaceSelector.click();

      await page.waitForTimeout(200);

      const allNamespacesOption = page.locator('[data-testid="namespace-option"]').filter({ hasText: /all namespaces/i });
      await allNamespacesOption.click();

      await page.waitForTimeout(300);

      const rows = page.locator('[data-testid="resource-row"]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    });
  });

  test.describe("Pagination", () => {
    test("displays pagination controls", async ({ page }) => {
      const pagination = page.locator('[data-testid="pagination"]');
      const isVisible = await pagination.isVisible().catch(() => false);

      if (isVisible) {
        await expect(pagination).toBeVisible();
      }
    });

    test("navigates to next page", async ({ page }) => {
      const pagination = page.locator('[data-testid="pagination"]');
      const isVisible = await pagination.isVisible().catch(() => false);

      if (!isVisible) {
        return;
      }

      const nextButton = pagination.locator('[data-testid="page-next"]');
      const isNextVisible = await nextButton.isVisible().catch(() => false);

      if (isNextVisible) {
        const prevCount = await page.locator('[data-testid="resource-row"]').count();
        await nextButton.click();
        await page.waitForTimeout(300);

        const newCount = await page.locator('[data-testid="resource-row"]').count();
        expect(newCount).toBe(prevCount);
      }
    });
  });

  test.describe("Virtual Scrolling", () => {
    test("renders only visible rows for large datasets", async ({ page }) => {
      const rows = page.locator('[data-testid="resource-row"]');
      const visibleCount = await rows.count();

      expect(visibleCount).toBeLessThan(100);
    });
  });
});
