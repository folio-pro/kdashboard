/**
 * Regression: a pod DETAIL tab restored from a previous session rendered an
 * EMPTY panel on cold boot. The selected resource is ephemeral (never
 * persisted), and initApp loaded contexts/namespaces/counts but never
 * re-selected the restored tab's resource — so DetailPanel had selectedResource
 * === null and showed nothing.
 *
 * Fix: App.initApp now calls bootstrapActiveTab(), which re-selects the resource
 * via k8sStore.selectResourceByRef() (get_resource by Kind, falling back to a
 * list+find by plural type).
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const POD_NAME = "restored-pod-7f9c2";

const SEED_TABS = {
  version: 1,
  tabs: [
    {
      id: "tab-detail-1",
      type: "details",
      label: POD_NAME,
      closable: true,
      resourceName: POD_NAME,
      resourceType: "Pod", // Kind form — how the table-row click persists it
      namespace: "default",
    },
  ],
  activeTabId: "tab-detail-1",
};

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "get_resource") {
    return {
      kind: "Pod",
      api_version: "v1",
      metadata: {
        name: "${POD_NAME}",
        namespace: "default",
        uid: "u-restored-1",
        creation_timestamp: "2024-01-01T00:00:00Z",
        resource_version: "42",
        labels: { app: "demo" },
      },
      spec: { nodeName: "node-1", containers: [{ name: "main", image: "nginx:1.27" }] },
      status: {
        phase: "Running",
        podIP: "10.0.0.5",
        containerStatuses: [
          { name: "main", image: "nginx:1.27", ready: true, restartCount: 0, state: { running: { startedAt: "2024-01-01T00:00:00Z" } } },
        ],
      },
    };
  }
}`);

// Same layout but the detail tab is NOT active: a table tab has focus on boot.
// bootstrapActiveTab only hydrates the active tab, so switching to the detail
// tab later must re-fetch its resource (rehydrateResourceTab in App.svelte).
const SEED_TABS_BACKGROUND_DETAIL = {
  version: 1,
  tabs: [
    {
      id: "tab-table-1",
      type: "table",
      label: "Pods",
      closable: true,
      resourceType: "pods",
      namespace: "default",
    },
    ...SEED_TABS.tabs,
  ],
  activeTabId: "tab-table-1",
};

test.describe("session restore", () => {
  test("restored pod detail tab is hydrated, not blank, on cold boot", async ({ page, mockInvoke }) => {
    await mockInvoke(MOCK);
    // Seed the persisted tabs BEFORE any app script runs, so the ui store
    // hydrates this detail tab as the active view on boot.
    await page.addInitScript(`window.localStorage.setItem("kdashboard-tabs-v1", '${JSON.stringify(SEED_TABS)}');`);

    await page.goto("/");

    // The detail header renders resource.metadata.name once selectedResource is
    // set. Before the fix this never appeared (panel was blank).
    await expect(page.getByText(POD_NAME).first()).toBeVisible({ timeout: 10_000 });
    // And the pod's kind/identity is shown, proving the full object hydrated.
    await expect(page.getByText("node-1").first()).toBeVisible({ timeout: 10_000 });
  });

  test("boot shows loading skeleton, never a false 'no pods' empty state", async ({ page, mockInvoke }) => {
    // list_resources resolves after 800ms — during that window the table must
    // show the loading skeleton, NOT the empty state (isLoading is delayed
    // 200ms, so before viewLoaded existed the empty state flashed first).
    await mockInvoke(`(cmd, args) => {
      if (cmd === "get_contexts") return ["bench"];
      if (cmd === "get_current_context") return "bench";
      if (cmd === "get_namespaces") return ["default"];
      if (cmd === "get_resource_counts") return {};
      if (cmd === "bench_config") return { enabled: false };
      if (cmd === "list_resources") {
        return new Promise((resolve) => setTimeout(() => resolve({
          items: [{
            kind: "Pod", api_version: "v1",
            metadata: { name: "slow-pod-1", namespace: "default", uid: "u-slow-1",
              creation_timestamp: "2024-01-01T00:00:00Z", resource_version: "1" },
            spec: { nodeName: "node-1", containers: [{ name: "main", image: "nginx" }] },
            status: { phase: "Running" },
          }],
          resource_type: "pods",
        }), 800));
      }
      return null;
    }`);
    await page.addInitScript(`window.localStorage.setItem("kdashboard-tabs-v1", '${JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-table-1", type: "table", label: "Pods", closable: true, resourceType: "pods", namespace: "default" }],
      activeTabId: "tab-table-1",
    })}');`);

    // Record whether the empty state EVER renders during boot — a one-shot
    // assertion races the ~200ms flash window and passes vacuously.
    await page.addInitScript(`
      (window).__sawEmptyState = false;
      const scan = () => {
        if (document.body && /No pods/i.test(document.body.textContent || "")) {
          (window).__sawEmptyState = true;
        }
        requestAnimationFrame(scan);
      };
      requestAnimationFrame(scan);
    `);

    await page.goto("/");

    // Data lands after the delay…
    await expect(page.getByText("slow-pod-1")).toBeVisible({ timeout: 10_000 });
    // …and at no point before that did the false empty state flash.
    const sawEmpty = await page.evaluate(() => (window as unknown as { __sawEmptyState: boolean }).__sawEmptyState);
    expect(sawEmpty).toBe(false);
  });

  test("restored BACKGROUND detail tab hydrates when switched to", async ({ page, mockInvoke }) => {
    await mockInvoke(MOCK);
    await page.addInitScript(`window.localStorage.setItem("kdashboard-tabs-v1", '${JSON.stringify(SEED_TABS_BACKGROUND_DETAIL)}');`);

    await page.goto("/");
    // Boot lands on the table tab; the detail tab is restored but unhydrated.
    const detailTab = page.getByRole("tab", { name: POD_NAME }).or(page.getByText(POD_NAME).first());
    await expect(detailTab.first()).toBeVisible({ timeout: 10_000 });

    // Switch to the restored detail tab.
    await detailTab.first().click();

    // Before the fix the panel stayed empty forever (cachedResource is never
    // persisted and nothing re-fetched it). Now it must show the pod's data.
    await expect(page.getByTestId("detail-panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("node-1").first()).toBeVisible({ timeout: 10_000 });
  });
});
