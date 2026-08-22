/**
 * The detail panel (docked aside and full tab) against the default mock
 * cluster: identity, the summary strip, subtabs, and the page variant's
 * actions. Pods are the richest case (Logs / Shell / Port forward).
 */
import { test, expect, tableRows } from "./helpers";

test.describe("DetailPanel", () => {
  test.describe("Docked aside", () => {
    test.beforeEach(async ({ page }) => {
      await tableRows(page).first().click();
      await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();
    });

    test("shows the resource's name, kind and namespace", async ({ page }) => {
      const panel = page.locator('[data-testid="detail-panel"]');
      const name = (await tableRows(page).first().locator('[data-testid="cell-name"]').textContent())?.trim() ?? "";
      await expect(panel.locator('[data-testid="detail-resource-name"]')).toHaveText(name);
      await expect(panel.getByText(/Pod\s*·\s*default/)).toBeVisible();
    });

    test("opens on the Overview subtab with the summary strip", async ({ page }) => {
      const panel = page.locator('[data-testid="detail-panel"]');
      await expect(panel.locator('[data-testid="summary-strip"]')).toBeVisible();
      await expect(panel.locator('[data-testid="summary-strip"]')).toContainText("Status");
      await expect(panel.locator('[data-testid="summary-strip"]')).toContainText("Running");
      await expect(panel.locator('[data-testid="summary-strip"]')).toContainText("1/1");
    });

    test("a healthy pod shows no attention block", async ({ page }) => {
      await expect(page.locator('[data-testid="attention-block"]')).toHaveCount(0);
    });

    test("switches between subtabs", async ({ page }) => {
      const panel = page.locator('[data-testid="detail-panel"]');
      await panel.getByRole("button", { name: "Events" }).click();
      await expect(panel.locator('[data-testid="summary-strip"]')).toBeHidden();
      await panel.getByRole("button", { name: "Overview" }).click();
      await expect(panel.locator('[data-testid="summary-strip"]')).toBeVisible();
    });

    test("the close button hides the aside", async ({ page }) => {
      await page.getByRole("button", { name: "Close detail" }).click();
      await expect(page.locator('[data-testid="detail-panel"]')).toBeHidden();
    });
  });

  test.describe("Detail tab", () => {
    test.beforeEach(async ({ page }) => {
      await tableRows(page).first().dblclick();
      await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();
    });

    test("offers the pod actions with labels", async ({ page }) => {
      for (const name of ["Logs", "Shell", "Edit", "Delete"]) {
        await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible();
      }
    });

    test("the Shell action switches to the terminal subtab", async ({ page }) => {
      await page.getByRole("button", { name: "Shell", exact: true }).first().click();
      await expect(page.locator('[data-testid="terminal-panel"]')).toBeVisible();
    });

    test("Escape goes back to the table", async ({ page }) => {
      await page.keyboard.press("Escape");
      await expect(tableRows(page).first()).toBeVisible();
    });
  });
});
