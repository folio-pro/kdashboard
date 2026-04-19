import { test as base, type Page } from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await use(page);
  },
});

export async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(300);
}

export async function filterByResourceType(page: Page, resourceType: string): Promise<void> {
  await page.click('[data-testid="resource-type-filter"]');
  await page.fill('[data-testid="resource-type-search"]', resourceType);
  await page.click(`[data-testid="resource-type-${resourceType}"]`);
}

export async function selectNamespace(page: Page, namespace: string): Promise<void> {
  await page.click('[data-testid="namespace-selector"]');
  await page.fill('[data-testid="namespace-search"]', namespace);
  await page.click(`[data-testid="namespace-option-${namespace}"]`);
}

export async function getSafetyTierColor(page: Page, tier: "green" | "yellow" | "red" | "blacked"): Promise<string> {
  const tierColors: Record<string, string> = {
    green: "rgb(34, 197, 94)",
    yellow: "rgb(234, 179, 8)",
    red: "rgb(239, 68, 68)",
    blacked: "rgb(107, 114, 128)",
  };
  return tierColors[tier];
}
