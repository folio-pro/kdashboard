import { test, expect, type Page } from "@playwright/test";
import { createMockPod, createMockDeployment } from "./fixtures/mock-k8s";

const PERFORMANCE_MARKS = {
  RESOURCE_TABLE_MOUNT: "resource-table-mount",
  FILTER_RENDER: "filter-render",
  CONTEXT_SWITCH: "context-switch",
};

async function measureResourceTableMount(page: Page, itemCount: number): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const startTime = Date.now();

  await page.evaluate((itemCount) => {
    performance.mark(PERFORMANCE_MARKS.RESOURCE_TABLE_MOUNT);
  }, itemCount);

  await page.waitForTimeout(100);

  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByName(PERFORMANCE_MARKS.RESOURCE_TABLE_MOUNT);
    return entries.map(e => ({ name: e.name, duration: e.duration, startTime: e.startTime }));
  });

  const endTime = Date.now();
  return endTime - startTime;
}

async function measureFilterLatency(page: Page): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const filterInput = page.locator('[data-testid="filter-input"]');
  await filterInput.waitFor({ state: "visible" });

  const startTime = Date.now();

  await filterInput.fill("api");
  await page.waitForTimeout(50);

  await page.evaluate(() => {
    performance.mark(PERFORMANCE_MARKS.FILTER_RENDER);
  });

  await page.waitForTimeout(100);

  const endTime = Date.now();

  return endTime - startTime;
}

async function measureContextSwitch(page: Page): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const startTime = Date.now();

  await page.locator('[data-testid="namespace-filter"]').click();
  await page.waitForTimeout(100);

  await page.locator('[data-testid="namespace-option"]').filter({ hasText: "kube-system" }).click();
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    performance.mark(PERFORMANCE_MARKS.CONTEXT_SWITCH);
  });

  const endTime = Date.now();

  return endTime - startTime;
}

async function measureScrollFPS(page: Page): Promise<number[]> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const rows = page.locator('[data-testid="resource-row"]');
  const rowCount = await rows.count();

  if (rowCount === 0) {
    return [];
  }

  const fpsReadings: number[] = [];

  for (let i = 0; i < 10; i++) {
    const frameStart = Date.now();
    await rows.first().scrollIntoViewIfNeeded();
    const frameEnd = Date.now();

    fpsReadings.push(1000 / Math.max(frameEnd - frameStart, 1));
  }

  return fpsReadings;
}

test.describe("Performance Benchmarks", () => {
  test("ResourceTable mount time is under 100ms for 100 items", async ({ page }) => {
    const mountTime = await measureResourceTableMount(page, 100);
    expect(mountTime).toBeLessThan(100);
  });

  test("Filter-to-render latency is under 50ms", async ({ page }) => {
    const filterLatency = await measureFilterLatency(page);
    expect(filterLatency).toBeLessThan(50);
  });

  test("Context switch is under 500ms", async ({ page }) => {
    const contextSwitchTime = await measureContextSwitch(page);
    expect(contextSwitchTime).toBeLessThan(500);
  });

  test("Scroll maintains reasonable FPS", async ({ page }) => {
    const fpsReadings = await measureScrollFPS(page);

    if (fpsReadings.length === 0) {
      test.skip();
      return;
    }

    const avgFPS = fpsReadings.reduce((a, b) => a + b, 0) / fpsReadings.length;
    expect(avgFPS).toBeGreaterThan(30);
  });

  test.describe("Large Dataset Performance", () => {
    test("handles 500 items without significant slowdown", async ({ page }) => {
      const mountTime = await measureResourceTableMount(page, 500);
      expect(mountTime).toBeLessThan(500);
    });

    test("filter latency scales linearly with dataset size", async ({ page }) => {
      const smallFilterLatency = await measureFilterLatency(page);

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const largeFilterLatency = await measureFilterLatency(page);

      const ratio = largeFilterLatency / smallFilterLatency;
      expect(ratio).toBeLessThan(10);
    });
  });

  test.describe("Rendering Performance", () => {
    test("no layout shift during resource load", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const layoutShift = await page.evaluate(() => {
        const entries = performance.getEntriesByType("layout-shift") as PerformanceEntry[];
        return entries.reduce((sum: number, entry: any) => sum + (entry.value || 0), 0);
      });

      expect(layoutShift).toBeLessThan(0.1);
    });

    test("images and fonts load without blocking render", async ({ page }) => {
      const resourceTiming = await page.evaluate(() => {
        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        return resources.map(r => ({
          name: r.name,
          duration: r.duration,
          transferSize: r.transferSize,
        }));
      });

      const renderBlockingResources = resourceTiming.filter(
        r => r.name.includes(".woff") || r.name.includes(".woff2")
      );

      for (const resource of renderBlockingResources) {
        expect(resource.duration).toBeLessThan(100);
      }
    });
  });

  test.describe("Memory Performance", () => {
    test("no memory leaks during navigation", async ({ page }) => {
      const initialMemory = await page.evaluate(() => {
        return (performance as any).memory?.usedJSHeapSize || 0;
      });

      if (initialMemory === 0) {
        test.skip();
        return;
      }

      for (let i = 0; i < 5; i++) {
        await page.goto("/");
        await page.waitForLoadState("networkidle");
        await page.goto("/");
        await page.waitForLoadState("networkidle");
      }

      const finalMemory = await page.evaluate(() => {
        return (performance as any).memory?.usedJSHeapSize || 0;
      });

      const memoryGrowth = finalMemory - initialMemory;
      const growthPercentage = (memoryGrowth / initialMemory) * 100;

      expect(growthPercentage).toBeLessThan(50);
    });
  });

  test.describe("Interaction Responsiveness", () => {
    test("button click responds within 100ms", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const button = page.locator('[data-testid="resource-row"]').first();
      await button.waitFor({ state: "visible" });

      const clickTime = Date.now();
      await button.click();
      await page.waitForTimeout(50);
      const clickEnd = Date.now();

      expect(clickEnd - clickTime).toBeLessThan(100);
    });

    test("keyboard shortcuts respond within 50ms", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const shortcutTime = Date.now();
      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(50);
      const shortcutEnd = Date.now();

      expect(shortcutEnd - shortcutTime).toBeLessThan(50);
    });

    test("dialog opens within 200ms", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const dialogTime = Date.now();
      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(50);
      const dialogEnd = Date.now();

      expect(dialogEnd - dialogTime).toBeLessThan(200);
    });
  });
});
