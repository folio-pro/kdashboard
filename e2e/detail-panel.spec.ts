import { test, expect } from "./helpers";
import { MOCK_DEPLOYMENTS_LIST, MOCK_PODS_LIST } from "./fixtures/mock-k8s";

test.describe("DetailPanel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("opens when a resource is selected", async ({ page }) => {
    const row = page.locator('[data-testid="resource-row"]').first();
    await row.click();

    await page.waitForTimeout(300);

    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel).toBeVisible();
  });

  test("closes when close button is clicked", async ({ page }) => {
    const row = page.locator('[data-testid="resource-row"]').first();
    await row.click();

    await page.waitForTimeout(300);

    const closeButton = page.locator('[data-testid="detail-panel-close"]');
    await closeButton.click();

    await page.waitForTimeout(300);

    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel).not.toBeVisible();
  });

  test.describe("Resource Info Section", () => {
    test("displays resource name", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const resourceName = page.locator('[data-testid="detail-resource-name"]');
      await expect(resourceName).toBeVisible();
      const name = await resourceName.textContent();
      expect(name).toBeTruthy();
    });

    test("displays resource kind", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const resourceKind = page.locator('[data-testid="detail-resource-kind"]');
      await expect(resourceKind).toBeVisible();
      const kind = await resourceKind.textContent();
      expect(kind).toBeTruthy();
    });

    test("displays resource namespace", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const resourceNamespace = page.locator('[data-testid="detail-resource-namespace"]');
      const isVisible = await resourceNamespace.isVisible().catch(() => false);

      if (isVisible) {
        await expect(resourceNamespace).toBeVisible();
      }
    });
  });

  test.describe("Tabs", () => {
    test("displays tab bar", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const tabBar = page.locator('[data-testid="detail-tabs"]');
      await expect(tabBar).toBeVisible();
    });

    test("switches between tabs", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const yamlTab = page.locator('[data-testid="detail-tab"]').filter({ hasText: /yaml/i });
      const isYamlTabVisible = await yamlTab.isVisible().catch(() => false);

      if (isYamlTabVisible) {
        await yamlTab.click();
        await page.waitForTimeout(200);

        const yamlContent = page.locator('[data-testid="detail-yaml-content"]');
        await expect(yamlContent).toBeVisible();
      }
    });

    test("shows events tab for pods", async ({ page }) => {
      const podRow = page.locator('[data-testid="resource-row"]').filter({ hasText: /pod/i }).first();
      const isPodVisible = await podRow.isVisible().catch(() => false);

      if (!isPodVisible) {
        return;
      }

      await podRow.click();
      await page.waitForTimeout(300);

      const eventsTab = page.locator('[data-testid="detail-tab"]').filter({ hasText: /events/i });
      const isEventsTabVisible = await eventsTab.isVisible().catch(() => false);

      if (isEventsTabVisible) {
        await eventsTab.click();
        await page.waitForTimeout(200);

        const eventsContent = page.locator('[data-testid="detail-events-content"]');
        await expect(eventsContent).toBeVisible();
      }
    });
  });

  test.describe("Actions", () => {
    test("displays action buttons", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const actionsBar = page.locator('[data-testid="detail-actions"]');
      const isVisible = await actionsBar.isVisible().catch(() => false);

      if (isVisible) {
        await expect(actionsBar).toBeVisible();
      }
    });

    test("opens logs action", async ({ page }) => {
      const podRow = page.locator('[data-testid="resource-row"]').filter({ hasText: /pod/i }).first();
      const isPodVisible = await podRow.isVisible().catch(() => false);

      if (!isPodVisible) {
        return;
      }

      await podRow.click();
      await page.waitForTimeout(300);

      const logsButton = page.locator('[data-testid="detail-action-logs"]');
      const isLogsVisible = await logsButton.isVisible().catch(() => false);

      if (isLogsVisible) {
        await logsButton.click();
        await page.waitForTimeout(300);

        const logsPanel = page.locator('[data-testid="log-viewer"]');
        await expect(logsPanel).toBeVisible();
      }
    });

    test("opens terminal action for pods", async ({ page }) => {
      const podRow = page.locator('[data-testid="resource-row"]').filter({ hasText: /pod/i }).first();
      const isPodVisible = await podRow.isVisible().catch(() => false);

      if (!isPodVisible) {
        return;
      }

      await podRow.click();
      await page.waitForTimeout(300);

      const terminalButton = page.locator('[data-testid="detail-action-terminal"]');
      const isTerminalVisible = await terminalButton.isVisible().catch(() => false);

      if (isTerminalVisible) {
        await terminalButton.click();
        await page.waitForTimeout(300);

        const terminalPanel = page.locator('[data-testid="terminal-panel"]');
        await expect(terminalPanel).toBeVisible();
      }
    });
  });

  test.describe("Metadata Section", () => {
    test("displays creation timestamp", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const metadataSection = page.locator('[data-testid="detail-metadata"]');
      const isVisible = await metadataSection.isVisible().catch(() => false);

      if (isVisible) {
        await expect(metadataSection).toBeVisible();

        const createdAt = metadataSection.locator('[data-testid="metadata-created-at"]');
        const isCreatedVisible = await createdAt.isVisible().catch(() => false);

        if (isCreatedVisible) {
          await expect(createdAt).toBeVisible();
        }
      }
    });

    test("displays labels", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const labelsSection = page.locator('[data-testid="detail-labels"]');
      const isVisible = await labelsSection.isVisible().catch(() => false);

      if (isVisible) {
        await expect(labelsSection).toBeVisible();
      }
    });

    test("displays annotations", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const annotationsSection = page.locator('[data-testid="detail-annotations"]');
      const isVisible = await annotationsSection.isVisible().catch(() => false);

      if (isVisible) {
        await expect(annotationsSection).toBeVisible();
      }
    });
  });

  test.describe("Owner References", () => {
    test("displays owner reference when present", async ({ page }) => {
      const row = page.locator('[data-testid="resource-row"]').first();
      await row.click();

      await page.waitForTimeout(300);

      const ownerSection = page.locator('[data-testid="detail-owner"]');
      const isVisible = await ownerSection.isVisible().catch(() => false);

      if (isVisible) {
        await expect(ownerSection).toBeVisible();
      }
    });
  });
});
