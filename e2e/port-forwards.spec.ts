/**
 * Saved port forwards: save an active forward from the pod detail, see it in
 * the Port Forwards view, stop it, and start it again — which resolves the
 * Deployment behind the pod to a running pod before opening the session.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const created = new Date(Date.now() - 3_600_000).toISOString();

const POD = {
  kind: "Pod",
  api_version: "v1",
  metadata: {
    name: "web-7f9c8d-abc12",
    namespace: "default",
    uid: "pod-1",
    creation_timestamp: created,
    labels: { app: "web" },
    annotations: {},
    owner_references: [{ kind: "ReplicaSet", name: "web-7f9c8d", api_version: "apps/v1", uid: "rs-1", controller: true }],
    resource_version: "1",
  },
  spec: { containers: [{ name: "web", image: "nginx:1.27", ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }] }] },
  status: {
    phase: "Running",
    podIP: "10.0.0.1",
    conditions: [{ type: "Ready", status: "True" }],
    containerStatuses: [{ name: "web", image: "nginx:1.27", ready: true, restartCount: 0, state: { running: { startedAt: created } } }],
  },
};

const DEPLOYMENT = {
  kind: "Deployment",
  api_version: "apps/v1",
  metadata: { name: "web", namespace: "default", uid: "dep-1", creation_timestamp: created, labels: {}, annotations: {}, owner_references: [], resource_version: "1" },
  spec: { replicas: 1, selector: { matchLabels: { app: "web" } } },
  status: { replicas: 1, readyReplicas: 1 },
};

const MOCK = clusterBootMock(`(cmd, args) => {
  const pod = ${JSON.stringify(POD)};
  if (cmd === "list_resources") {
    return { resource_type: args.resourceType, items: args.resourceType === "pods" ? [pod] : [] };
  }
  if (cmd === "get_resource") {
    if (args.kind === "Deployment" && args.name === "web") return ${JSON.stringify(DEPLOYMENT)};
    if (args.kind === "Pod") return pod;
    return null;
  }
  if (cmd === "list_pods_by_selector") return { resource_type: "pods", items: [pod] };
  if (cmd === "start_port_forward") {
    window.__pfStarts = (window.__pfStarts ?? []).concat([args]);
    return { session_id: args.sessionId, local_port: args.localPort };
  }
  if (cmd === "stop_port_forward") return null;
  if (cmd === "save_settings") return null;
  if (cmd === "get_resource_events") return [];
  if (cmd === "get_pod_metrics") return { available: false, reason: "mock", pods: [] };
  if (cmd === "discover_crds") return [];
  if (cmd === "query_prometheus_range") return { configured: false, series: [] };
}`);

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
});

test("save an active forward, stop it and start it again from the saved list", async ({ page }) => {
  // Forward 8080 from the pod detail.
  await page.locator("tbody tr").first().click();
  const panel = page.locator('[data-testid="detail-panel"]');
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Forward" }).click();
  await expect(panel.getByText("localhost:8080")).toBeVisible();

  // Save it: the pod belongs to deploy/web, so that is what gets remembered.
  const save = panel.locator('[data-testid="save-port-forward"]');
  await expect(save).toHaveAttribute("title", /deploy\/web → localhost:8080/);
  await save.click();
  await expect(save).toHaveAttribute("title", /Saved as deploy\/web/);

  // The Port Forwards view lists it as saved and active.
  await page.getByRole("button", { name: /^Port Forwards / }).first().click();
  const saved = page.locator('[data-testid="saved-port-forward"]');
  await expect(saved).toHaveCount(1);
  await expect(saved).toContainText("deploy/web");
  await expect(saved).toContainText("active · web-7f9c8d-abc12");
  await expect(page.locator('[data-testid="port-forward-save"]')).toContainText("Saved");

  // Stop the saved forward: the session goes away, the entry stays.
  await saved.getByRole("button", { name: "Stop" }).click();
  await expect(saved).toContainText("stopped");
  await expect(page.getByText("No active port forwards")).toBeVisible();

  // Start resolves deploy/web → its running pod and opens a fresh session.
  await saved.locator('[data-testid="saved-port-forward-start"]').click();
  await expect(saved).toContainText("active · web-7f9c8d-abc12");
  const starts = await page.evaluate(() => (window as unknown as { __pfStarts: Array<Record<string, unknown>> }).__pfStarts);
  expect(starts).toHaveLength(2);
  expect(starts[1]).toMatchObject({ podName: "web-7f9c8d-abc12", containerPort: 8080, localPort: 8080 });

  // Auto-start is a per-forward toggle.
  const auto = saved.locator('[data-testid="saved-port-forward-autostart"]');
  await expect(auto).toHaveAttribute("title", /off/);
  await auto.click();
  await expect(auto).toHaveAttribute("title", /Auto-start on/);
});
