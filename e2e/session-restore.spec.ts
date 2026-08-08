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
});
