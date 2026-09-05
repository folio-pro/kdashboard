/**
 * Performance REGRESSION guards — deterministic, in-page measured.
 *
 * Every duration here is taken with performance.now() inside the page, from
 * the state change to the paint that reflects it, so Playwright round-trips
 * and worker contention never leak into the number. Thresholds are several
 * times the measured values (see scripts/bench/README.md for the real
 * benchmark, e2e/perf-bench.spec.ts) — they exist to catch an order-of-
 * magnitude regression, not to track drift.
 *
 * Datasets are injected through the DEV-only window.__kdash store hook (see
 * src/main.ts), the same way the benchmark does, so the render path under
 * test is the real one.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./helpers";

/** Generated in-page: pods rich enough to exercise the real cell renderers. */
const GEN = `(n) => {
  const phases = ["Running", "Running", "Pending", "Failed"];
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    const phase = phases[i % phases.length];
    items[i] = {
      kind: "Pod", api_version: "v1",
      metadata: {
        name: "perf-" + String(i).padStart(5, "0"), namespace: ["default", "prod"][i % 2],
        uid: "perf-uid-" + i, creation_timestamp: new Date(Date.now() - (i % 300) * 60000).toISOString(),
        labels: { app: "app-" + (i % 20) }, resource_version: String(i),
      },
      spec: { nodeName: "node-" + (i % 4), containers: [{ name: "c", image: "nginx:1.27" }] },
      status: {
        phase, podIP: "10.0." + (i % 250) + ".1",
        containerStatuses: [{ name: "c", image: "nginx:1.27", ready: phase === "Running", restartCount: i % 5,
          state: phase === "Running" ? { running: {} } : { waiting: { reason: "ContainerCreating" } } }],
      },
    };
  }
  return items;
}`;

async function bootWithStores(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__kdash?.k8sStore, null, { timeout: 15_000 });
  await page.evaluate(() => {
    const { k8sStore, uiStore } = (window as any).__kdash;
    k8sStore.connectionStatus = "connected";
    k8sStore.currentNamespace = "";
    k8sStore.selectedResourceType = "pods";
    uiStore.backToTable();
    uiStore.setFilter("");
  });
}

/** Assign `size` generated pods to the store and measure until rows are painted. */
async function measureMount(page: Page, size: number): Promise<{ ms: number; rendered: number }> {
  return page.evaluate(async ({ size, gen }) => {
    const { k8sStore } = (window as any).__kdash;
    const items = eval(gen)(size);
    k8sStore.resources = { items: [], resource_type: "pods" };
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const t0 = performance.now();
    k8sStore.resources = { items, resource_type: "pods" };
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return { ms: performance.now() - t0, rendered: document.querySelectorAll("tbody tr").length };
  }, { size, gen: GEN });
}

/** Set the filter and measure until every painted row matches it. */
async function measureFilter(page: Page, needle: string): Promise<number> {
  return page.evaluate(async (needle) => {
    const { uiStore } = (window as any).__kdash;
    const cells = () => Array.from(document.querySelectorAll('tbody tr [data-testid="cell-name"]'));
    const settled = () => {
      const c = cells();
      return c.length > 0 && c.every((el) => (el.textContent ?? "").includes(needle));
    };
    const t0 = performance.now();
    uiStore.setFilter(needle);
    while (!settled() && performance.now() - t0 < 5000) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    const ms = performance.now() - t0;
    uiStore.setFilter("");
    return ms;
  }, needle);
}

test.describe("Performance regression guards", () => {
  test("table mount stays virtualized and fast from 200 to 5000 rows", async ({ page }) => {
    await bootWithStores(page);
    for (const size of [200, 5000]) {
      const { ms, rendered } = await measureMount(page, size);
      // A window of rows, never the whole list — the virtualizer invariant.
      expect(rendered, `rendered rows for ${size}`).toBeGreaterThan(0);
      expect(rendered, `rendered rows for ${size}`).toBeLessThan(150);
      // Measured ~30 ms in production builds; the dev server is slower.
      expect(ms, `mount ms for ${size}`).toBeLessThan(400);
    }
  });

  test("filter over 5000 rows paints within a few frames", async ({ page }) => {
    await bootWithStores(page);
    await measureMount(page, 5000);
    // The store debounces keystrokes by ~48 ms; measured ~55 ms end to end.
    const ms = await measureFilter(page, "perf-0012");
    expect(ms).toBeLessThan(300);
  });

  test("scrolling 5000 rows keeps per-frame main-thread work under budget", async ({ page }) => {
    await bootWithStores(page);
    await measureMount(page, 5000);
    const frames = await page.evaluate(async () => {
      const el = document.querySelector(".virtual-scroll-container") as HTMLElement | null;
      if (!el) return null;
      const max = el.scrollHeight - el.clientHeight;
      const out: number[] = [];
      for (let i = 1; i <= 60; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          const t0 = performance.now();
          el.scrollTop = (max / 60) * i;
          void el.offsetHeight; // force the virtualizer + layout to run now
          out.push(performance.now() - t0);
          resolve();
        }));
      }
      return out;
    });
    expect(frames, "virtual scroll container").not.toBeNull();
    const sorted = [...(frames as number[])].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    // Measured p95 ≈ 4–5 ms at 10k rows in production; 16.7 ms is one frame.
    expect(p95).toBeLessThan(16.7);
  });

  test("the command palette opens within a frame of the shortcut", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as any).__kdash?.k8sStore, null, { timeout: 15_000 });
    const ms = await page.evaluate(async () => {
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      while (!document.querySelector('[data-testid="command-palette"]') && performance.now() - t0 < 5000) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      return performance.now() - t0;
    });
    await expect(page.locator('[data-testid="command-palette"]')).toBeVisible();
    expect(ms).toBeLessThan(100);
  });

  test("selecting a row reflects in the DOM within a frame", async ({ page }) => {
    await bootWithStores(page);
    await measureMount(page, 200);
    const ms = await page.evaluate(async () => {
      const row = document.querySelector('[data-testid="resource-row"]') as HTMLElement;
      const t0 = performance.now();
      row.click();
      while (row.getAttribute("data-selected") !== "true" && performance.now() - t0 < 5000) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      return performance.now() - t0;
    });
    expect(ms).toBeLessThan(100);
  });

  test("replacing the list 30 times does not grow the JS heap", async ({ page }) => {
    await bootWithStores(page);
    await measureMount(page, 2000);
    const client = await page.context().newCDPSession(page);
    const heap = async () => {
      await client.send("HeapProfiler.collectGarbage");
      const { metrics } = await client.send("Performance.getMetrics");
      return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1048576;
    };
    await client.send("Performance.enable");
    const before = await heap();
    await page.evaluate(async ({ gen }) => {
      const { k8sStore } = (window as any).__kdash;
      const base = eval(gen)(2000);
      for (let i = 0; i < 30; i++) {
        const next = base.slice();
        for (let j = 0; j < 100; j++) {
          const idx = (i * 100 + j) % next.length;
          next[idx] = { ...next[idx], status: { ...next[idx].status, phase: j % 2 ? "Running" : "Pending" } };
        }
        k8sStore.resources = { items: next, resource_type: "pods" };
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      }
    }, { gen: GEN });
    const after = await heap();
    await client.detach();
    // Measured growth ≈ 1 MB (retained flash state for changed rows).
    expect(after - before).toBeLessThan(15);
  });
});
