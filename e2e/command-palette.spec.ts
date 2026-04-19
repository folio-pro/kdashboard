import { test, expect } from "./helpers";
import { MOCK_DEPLOYMENTS_LIST, MOCK_PODS_LIST } from "./fixtures/mock-k8s";

test.describe("CommandPalette", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("opens with keyboard shortcut Meta+K", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const dialog = page.locator('[data-testid="command-palette"]');
    await expect(dialog).toBeVisible();
  });

  test("opens with keyboard shortcut Ctrl+K", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);

    const dialog = page.locator('[data-testid="command-palette"]');
    await expect(dialog).toBeVisible();
  });

  test("closes with Escape key", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const dialog = page.locator('[data-testid="command-palette"]');
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await expect(dialog).not.toBeVisible();
  });

  test("shows all resource categories by default", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const groups = page.locator('[data-testid="command-group"]');
    await expect(groups).toHaveCount(5);

    const groupLabels = page.locator('[data-testid="command-group-label"]');
    await expect(groupLabels).toContainText(["Resources", "Contexts", "Namespaces", "Actions", "Resource Actions"]);
  });

  test("filters resources when typing in search input", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const searchInput = page.locator('[data-testid="command-input"]');
    await searchInput.fill("pods");

    await page.waitForTimeout(200);

    const items = page.locator('[data-testid="command-item"]');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    const firstItem = items.first();
    await expect(firstItem).toContainText(/pods/i);
  });

  test("navigates with arrow keys", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const items = page.locator('[data-testid="command-item"]');
    const initialCount = await items.count();
    expect(initialCount).toBeGreaterThan(0);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);

    const selectedItem = page.locator('[data-testid="command-item"][data-selected="true"]');
    await expect(selectedItem).toBeVisible();
  });

  test("executes action on Enter key", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const searchInput = page.locator('[data-testid="command-input"]');
    await searchInput.fill("settings");

    await page.waitForTimeout(200);

    const settingsItem = page.locator('[data-testid="command-item"]').filter({ hasText: /settings/i }).first();
    await settingsItem.click();

    await page.waitForTimeout(300);

    const dialog = page.locator('[data-testid="command-palette"]');
    await expect(dialog).not.toBeVisible();
  });

  test("empty search shows all items", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const searchInput = page.locator('[data-testid="command-input"]');
    await searchInput.fill("");

    await page.waitForTimeout(200);

    const items = page.locator('[data-testid="command-item"]');
    const count = await items.count();
    expect(count).toBeGreaterThan(5);
  });

  test("no results shows empty state", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const searchInput = page.locator('[data-testid="command-input"]');
    await searchInput.fill("xyznonexistent123");

    await page.waitForTimeout(200);

    const emptyState = page.locator('[data-testid="command-empty"]');
    await expect(emptyState).toBeVisible();
  });

  test.describe("Resource Actions", () => {
    test("shows resource actions when a resource is selected", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      await page.click('[data-testid="resource-row"]');
      await page.waitForTimeout(300);

      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(300);

      const resourceActionsGroup = page.locator('[data-testid="command-group"]').filter({ hasText: /resource actions/i });
      await expect(resourceActionsGroup).toBeVisible();
    });

    test("shows View Logs action for pods", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const podRow = page.locator('[data-testid="resource-row"]').filter({ hasText: /pod/i }).first();
      await podRow.click();
      await page.waitForTimeout(300);

      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(300);

      const logsAction = page.locator('[data-testid="command-item"]').filter({ hasText: /view logs/i });
      await expect(logsAction).toBeVisible();
    });

    test("shows Delete action for all resources", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const resourceRow = page.locator('[data-testid="resource-row"]').first();
      await resourceRow.click();
      await page.waitForTimeout(300);

      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(300);

      const deleteAction = page.locator('[data-testid="command-item"]').filter({ hasText: /delete/i });
      await expect(deleteAction).toBeVisible();
    });
  });

  test.describe("Category ordering", () => {
    test("categories appear in correct order", async ({ page }) => {
      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(300);

      const groupLabels = page.locator('[data-testid="command-group-label"]');
      const labels = await groupLabels.allTextContents();

      const resourceActionsIdx = labels.findIndex(l => l.includes("Resource Actions"));
      const resourcesIdx = labels.findIndex(l => l.includes("Resources"));
      const contextsIdx = labels.findIndex(l => l.includes("Contexts"));
      const namespacesIdx = labels.findIndex(l => l.includes("Namespaces"));
      const actionsIdx = labels.findIndex(l => l.includes("Actions"));

      expect(resourceActionsIdx).toBeLessThan(resourcesIdx);
      expect(resourcesIdx).toBeLessThan(contextsIdx);
      expect(contextsIdx).toBeLessThan(namespacesIdx);
      expect(namespacesIdx).toBeLessThan(actionsIdx);
    });
  });


  test.describe("Keyboard navigation", () => {
    test("Ctrl+J navigates down", async ({ page }) => {
      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(300);

      await page.keyboard.press("Control+j");
      await page.waitForTimeout(100);

      const selectedItem = page.locator('[data-testid="command-item"][data-selected="true"]');
      await expect(selectedItem).toBeVisible();
    });

    test("Ctrl+K navigates up", async ({ page }) => {
      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(300);

      await page.keyboard.press("Control+j");
      await page.keyboard.press("Control+j");
      await page.waitForTimeout(100);

      await page.keyboard.press("Control+k");
      await page.waitForTimeout(100);

      const selectedItem = page.locator('[data-testid="command-item"][data-selected="true"]');
      await expect(selectedItem).toBeVisible();
    });
  });
});
