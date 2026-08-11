/**
 * Reproducible FRONTEND performance benchmark — no cluster required.
 *
 * Boots the real renderer (Chromium, same Blink/compositor as Electron),
 * injects synthetic datasets straight into the live stores via the DEV-only
 * window.__kdash hook (see src/main.ts), and drives the real render path.
 *
 * Measures the things that decide whether the app "feels native at 60fps":
 *   - mount:   store assignment -> rows painted for a large list (cold render)
 *   - scroll:  per-frame main-thread cost while scrolling the virtual list
 *              end-to-end (virtualizer recompute + Svelte DOM mutation + layout)
 *   - filter:  keystroke -> filtered list painted
 *   - update:  watch-style wholesale items replacement -> repaint
 *
 * Run:  npx playwright test e2e/perf-bench.spec.ts --project=chromium --reporter=line
 * The webServer block in playwright.config.ts starts `npm run dev` automatically.
 */
import { test, expect } from "@playwright/test";

const SIZES = [200, 2000, 10000];
const FRAME_BUDGET_MS = 8; // main-thread budget/frame to leave room for paint+composite at 60fps

// Generated in-page (keeps the Playwright payload tiny). Produces pods rich
// enough to exercise TableRow's real work: containerStatuses with state +
// images (icon-url derivation), restarts, phase, node, ip, age.
const GEN = `(n) => {
  const phases = ["Running","Running","Running","Pending","Succeeded","Failed"];
  const images = ["nginx:1.27","redis:7.2","postgres:16","busybox:1.36","ghcr.io/app/api:v2.3.1","quay.io/team/worker:latest"];
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    const phase = phases[i % phases.length];
    const nc = 1 + (i % 3);
    const cs = [];
    for (let c = 0; c < nc; c++) {
      cs.push({
        name: "c" + c,
        image: images[(i + c) % images.length],
        ready: phase === "Running",
        restartCount: (i % 7 === 0) ? (i % 13) : 0,
        state: phase === "Running"
          ? { running: { startedAt: "2024-01-01T00:00:00Z" } }
          : phase === "Pending"
            ? { waiting: { reason: "ContainerCreating" } }
            : { terminated: { exitCode: phase === "Failed" ? 1 : 0 } },
      });
    }
    items[i] = {
      kind: "Pod",
      api_version: "v1",
      metadata: {
        name: "workload-" + String(i).padStart(5, "0") + "-" + (i * 2654435761 % 99999).toString(36),
        namespace: ["default","kube-system","prod","staging","observability"][i % 5],
        uid: "uid-" + i,
        creation_timestamp: new Date(Date.now() - (i % 500) * 3600000).toISOString(),
        labels: { app: "app-" + (i % 50), tier: i % 2 ? "backend" : "frontend" },
        resource_version: String(1000 + i),
      },
      spec: { nodeName: "node-" + (i % 12), containers: cs.map(c => ({ name: c.name, image: c.image })) },
      status: {
        phase,
        podIP: "10." + (i % 255) + "." + ((i >> 8) % 255) + "." + (i % 254 + 1),
        containerStatuses: cs,
      },
    };
  }
  return items;
}`;

interface FrameStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  overBudget: number; // % of frames exceeding FRAME_BUDGET_MS
  mean: number;
}

function summarize(samples: number[], budget: number): FrameStats {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const over = samples.filter((x) => x > budget).length;
  return {
    count: samples.length,
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    max: round(s[s.length - 1]),
    overBudget: round((over / samples.length) * 100),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}
const round = (n: number) => Math.round(n * 100) / 100;

test.describe("frontend perf bench", () => {
  test("table mount + scroll + filter across dataset sizes", async ({ page }) => {
    test.setTimeout(180_000);

    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await page.goto("/");
    // Wait for the DEV store hook to attach.
    await page.waitForFunction(() => !!(window as any).__kdash?.k8sStore, null, { timeout: 15_000 });

    // Force a clean, connected table view regardless of the (cluster-less) boot state.
    await page.evaluate(() => {
      const { k8sStore, uiStore } = (window as any).__kdash;
      k8sStore.connectionStatus = "connected";
      k8sStore.error = null;
      k8sStore.currentContext = "bench";
      k8sStore.currentNamespace = "";
      k8sStore.selectedResourceType = "pods";
      uiStore.backToTable();
      uiStore.setFilter?.("");
    });

    const report: Record<string, unknown> = {};

    for (const size of SIZES) {
      // ---- MOUNT (cold): assign dataset -> rows painted ----
      const mount = await page.evaluate(async ({ size, gen }) => {
        const { k8sStore } = (window as any).__kdash;
        const items = (eval(gen))(size);
        // Clear first so the assignment is a genuine cold render of `size` rows.
        k8sStore.resources = { items: [], resource_type: "pods" };
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const t0 = performance.now();
        k8sStore.resources = { items, resource_type: "pods" };
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const t1 = performance.now();
        const rendered = document.querySelectorAll('tbody tr').length;
        return { ms: t1 - t0, rendered };
      }, { size, gen: GEN });

      // ---- SCROLL: per-frame main-thread cost across the full list ----
      const scroll = await page.evaluate(async ({ budget }) => {
        const el = document.querySelector('.virtual-scroll-container') as HTMLElement;
        if (!el) return null;
        const maxScroll = el.scrollHeight - el.clientHeight;
        const STEPS = 150;
        const step = maxScroll / STEPS;
        const frames: number[] = [];
        el.scrollTop = 0;
        await new Promise((r) => requestAnimationFrame(r));
        for (let i = 1; i <= STEPS; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => {
            const t0 = performance.now();
            el.scrollTop = step * i;
            // Force the virtualizer's scroll handler + Svelte flush + style/layout
            // to run synchronously so we capture the real per-frame cost.
            void el.offsetHeight;
            const t1 = performance.now();
            frames.push(t1 - t0);
            resolve();
          }));
        }
        return frames;
      }, { budget: FRAME_BUDGET_MS });

      // ---- FILTER: keystroke -> filtered repaint (true end-to-end latency) ----
      const filter = await page.evaluate(async () => {
        const { uiStore } = (window as any).__kdash;
        const countRows = () => document.querySelectorAll('tbody tr').length;
        const before = countRows();
        const t0 = performance.now();
        uiStore.setFilter("workload-001"); // matches a single pod -> row set must shrink
        // Poll each frame until the rendered set reflects the filter (debounce + derive + paint).
        let waited = 0;
        while (countRows() >= before && waited < 1500) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          waited = performance.now() - t0;
        }
        const t1 = performance.now();
        const rendered = countRows();
        uiStore.setFilter("");
        await new Promise((r) => setTimeout(r, 80));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { ms: t1 - t0, rendered };
      });

      report[`n=${size}`] = {
        mountMs: round(mount.ms),
        mountRendered: mount.rendered,
        scroll: scroll ? summarize(scroll, FRAME_BUDGET_MS) : "no-container",
        filterMs: round(filter.ms),
        filterRendered: filter.rendered,
      };
    }

    // eslint-disable-next-line no-console
    console.log("\n__PERF_BENCH__" + JSON.stringify(report, null, 2));
    console.log("console.errors:", consoleErrors.slice(0, 5));

    // Smoke assertion: the harness produced data for every size.
    expect(Object.keys(report).length).toBe(SIZES.length);
  });

  test("navigation: type switch + detail open + watch churn", async ({ page }) => {
    test.setTimeout(120_000);
    // Stub the IPC bridge so lazy views (DetailPanel re-hydration) don't throw.
    await page.addInitScript(`
      Object.defineProperty(window, "electronAPI", {
        value: { invoke: async () => null, on: () => {}, off: () => {}, openExternal: async () => {} },
        writable: true, configurable: true,
      });
    `);
    await page.goto("/");
    await page.waitForFunction(() => !!(window as any).__kdash?.k8sStore, null, { timeout: 15_000 });

    const r = await page.evaluate(async ({ gen }) => {
      const { k8sStore, uiStore } = (window as any).__kdash;
      const make = eval(gen);
      const raf2 = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

      k8sStore.connectionStatus = "connected";
      k8sStore.error = null;
      k8sStore.currentContext = "bench";
      k8sStore.currentNamespace = "";
      uiStore.backToTable();

      const pods = make(1500);
      const deploys = make(1500).map((p: any, i: number) => ({ ...p, kind: "Deployment", api_version: "apps/v1",
        status: { replicas: 3, readyReplicas: i % 4 ? 3 : 1, availableReplicas: 3, updatedReplicas: 3 },
        spec: { replicas: 3 } }));

      // Warm up: initial pods render.
      k8sStore.selectedResourceType = "pods";
      k8sStore.resources = { items: pods, resource_type: "pods" };
      await raf2();

      // ---- NAV: pods -> deployments -> pods (column set changes too) ----
      const navSamples: number[] = [];
      for (let i = 0; i < 6; i++) {
        const toDeploy = i % 2 === 0;
        const t0 = performance.now();
        k8sStore.selectedResourceType = toDeploy ? "deployments" : "pods";
        k8sStore.resources = { items: toDeploy ? deploys : pods, resource_type: toDeploy ? "deployments" : "pods" };
        await raf2();
        navSamples.push(performance.now() - t0);
      }

      // ---- DETAIL OPEN (cold first, then warm) ----
      k8sStore.selectedResourceType = "pods";
      k8sStore.resources = { items: pods, resource_type: "pods" };
      await raf2();
      const openDetail = async () => {
        const t0 = performance.now();
        k8sStore.selectedResource = pods[10];
        uiStore.showDetails();
        // Wait until the lazy DetailPanel actually mounts.
        for (let k = 0; k < 240; k++) {
          if (document.querySelector('[data-testid="detail-panel"]')) break;
          await new Promise((res) => requestAnimationFrame(res));
        }
        const ms = performance.now() - t0;
        uiStore.backToTable();
        await raf2();
        return ms;
      };
      const detailColdMs = await openDetail();
      const detailWarmMs = await openDetail();

      // ---- WATCH CHURN: replace 10% of items wholesale, measure repaint ----
      const churnSamples: number[] = [];
      for (let i = 0; i < 8; i++) {
        const next = pods.slice();
        for (let j = 0; j < 150; j++) {
          const idx = (i * 150 + j) % next.length;
          next[idx] = { ...next[idx], status: { ...next[idx].status, phase: j % 2 ? "Running" : "Pending" } };
        }
        const t0 = performance.now();
        k8sStore.resources = { items: next, resource_type: "pods" };
        await raf2();
        churnSamples.push(performance.now() - t0);
      }

      const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      const rnd = (n: number) => Math.round(n * 100) / 100;
      return {
        navMedianMs: rnd(med(navSamples)),
        navMaxMs: rnd(Math.max(...navSamples)),
        detailColdMs: rnd(detailColdMs),
        detailWarmMs: rnd(detailWarmMs),
        churnMedianMs: rnd(med(churnSamples)),
        churnMaxMs: rnd(Math.max(...churnSamples)),
      };
    }, { gen: GEN });

    // eslint-disable-next-line no-console
    console.log("\n__NAV_BENCH__" + JSON.stringify(r, null, 2));
    expect(r.navMedianMs).toBeGreaterThan(0);
  });

  test("crd table: mount + scroll stay virtualized at 10k items", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(`
      Object.defineProperty(window, "electronAPI", {
        value: { invoke: async () => null, on: () => {}, off: () => {}, openExternal: async () => {} },
        writable: true, configurable: true,
      });
    `);
    await page.goto("/");
    await page.waitForFunction(() => !!(window as any).__kdash?.k8sStore, null, { timeout: 15_000 });

    const r = await page.evaluate(async () => {
      const { k8sStore, uiStore } = (window as any).__kdash;
      const raf2 = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const N = 10_000;
      const items = Array.from({ length: N }, (_, i) => ({
        kind: "Widget", api_version: "example.com/v1",
        metadata: {
          name: "widget-" + String(i).padStart(5, "0"),
          namespace: ["default", "prod", "staging"][i % 3],
          uid: "crd-uid-" + i,
          creation_timestamp: new Date(Date.now() - (i % 400) * 3600000).toISOString(),
        },
        spec: { size: i % 9, mode: i % 2 ? "active" : "passive" },
        status: { ready: i % 4 !== 0 },
      }));
      const columns = [
        { name: "Size", json_path: ".spec.size", type: "integer", description: "" },
        { name: "Mode", json_path: ".spec.mode", type: "string", description: "" },
        { name: "Ready", json_path: ".status.ready", type: "boolean", description: "" },
      ];

      k8sStore.connectionStatus = "connected";
      k8sStore.selectedCrd = { group: "example.com", version: "v1", kind: "Widget", plural: "widgets", scope: "Namespaced" };
      uiStore.showView("crd-table");
      await raf2();

      const t0 = performance.now();
      k8sStore.crdResources = { items, columns };
      // Lazy view + first paint.
      for (let k = 0; k < 240; k++) {
        if (document.querySelector("tbody tr")) break;
        await new Promise((res) => requestAnimationFrame(res));
      }
      await raf2();
      const mountMs = performance.now() - t0;
      const renderedRows = document.querySelectorAll("tbody tr").length;

      // Scroll through the list, measuring per-frame main-thread cost.
      const el = Array.from(document.querySelectorAll("div")).find(
        (d) => d.scrollHeight > d.clientHeight * 5 && d.querySelector("tbody"),
      ) as HTMLElement | undefined;
      let scrollP95 = -1;
      if (el) {
        const frames: number[] = [];
        const maxScroll = el.scrollHeight - el.clientHeight;
        for (let i = 1; i <= 100; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => {
            const t = performance.now();
            el.scrollTop = (maxScroll / 100) * i;
            void el.offsetHeight;
            frames.push(performance.now() - t);
            resolve();
          }));
        }
        frames.sort((a, b) => a - b);
        scrollP95 = frames[Math.floor(frames.length * 0.95)];
      }

      const rnd = (n: number) => Math.round(n * 100) / 100;
      return { mountMs: rnd(mountMs), renderedRows, total: N, scrollP95: rnd(scrollP95) };
    });

    // eslint-disable-next-line no-console
    console.log("\n__CRD_BENCH__" + JSON.stringify(r, null, 2));
    // Virtualization invariant: the DOM must hold a window of rows, not the list.
    expect(r.renderedRows).toBeGreaterThan(0);
    expect(r.renderedRows).toBeLessThan(200);
  });
});
