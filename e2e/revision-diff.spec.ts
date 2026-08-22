/**
 * Revision history on the Deployment detail: the Diff button compares a
 * revision's pod template with the current one in a read-only merge view, and
 * a second click re-targets the pair.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const created = new Date(Date.now() - 86_400_000).toISOString();

const DEPLOYMENT = {
  kind: "Deployment",
  api_version: "apps/v1",
  metadata: {
    name: "web",
    namespace: "default",
    uid: "dep-1",
    creation_timestamp: created,
    labels: { app: "web" },
    annotations: { "deployment.kubernetes.io/revision": "3" },
    owner_references: [],
    resource_version: "1",
  },
  spec: { replicas: 2, selector: { matchLabels: { app: "web" } }, template: { spec: { containers: [{ name: "web", image: "nginx:1.27" }] } } },
  status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2, observedGeneration: 3 },
};

const template = (image: string, extra = "") =>
  `metadata:\n  labels:\n    app: web\nspec:\n  containers:\n    - name: web\n      image: ${image}\n${extra}`;

const REVISIONS = [
  { revision: 3, name: "web-c3", created_at: created, images: ["nginx:1.27"], replicas: 2, is_current: true, template_yaml: template("nginx:1.27") },
  { revision: 2, name: "web-b2", created_at: created, images: ["nginx:1.26"], replicas: 0, is_current: false, template_yaml: template("nginx:1.26") },
  { revision: 1, name: "web-a1", created_at: created, images: ["nginx:1.25"], replicas: 0, is_current: false, template_yaml: template("nginx:1.25", "      env:\n        - name: DEBUG\n          value: \"1\"\n") },
];

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") {
    const items = args.resourceType === "deployments" ? ${JSON.stringify([DEPLOYMENT])} : [];
    return { resource_type: args.resourceType, items };
  }
  if (cmd === "list_deployment_revisions") return ${JSON.stringify(REVISIONS)};
  if (cmd === "list_pods_by_selector") return { resource_type: "pods", items: [] };
  if (cmd === "get_resource_events") return [];
  if (cmd === "discover_crds") return [];
  if (cmd === "query_prometheus_range") return { configured: false, series: [] };
}`);

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Deployments / }).first().click();
  await expect(page.getByRole("heading", { name: "Deployments", exact: true })).toBeVisible();
  await page.locator("tbody tr").first().click();
  await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();
});

test("Diff compares a revision's pod template against the current one", async ({ page }) => {
  const panel = page.locator('[data-testid="detail-panel"]');
  await expect(panel).toContainText("3 revisions");
  const diffButtons = panel.locator('[data-testid="revision-diff"]');
  await expect(diffButtons).toHaveCount(3);
  // The current revision cannot be diffed against itself until a pair exists.
  await expect(diffButtons.nth(0)).toBeDisabled();

  await diffButtons.nth(2).click();
  const diffPanel = panel.locator('[data-testid="revision-diff-panel"]');
  await expect(diffPanel).toBeVisible();
  await expect(diffPanel).toContainText("#1");
  await expect(diffPanel).toContainText("#3");
  await expect(diffPanel).toContainText("(current)");
  // Both documents render in the merge view.
  await expect(diffPanel.locator(".cm-content").first()).toContainText("nginx:1.25", { timeout: 10_000 });
  await expect(diffPanel.locator(".cm-content").nth(1)).toContainText("nginx:1.27");
  await expect(diffPanel.locator(".cm-content").first()).toContainText("DEBUG");

  // Picking another row while a diff is open re-targets: #1 vs #2.
  await diffButtons.nth(1).click();
  await expect(diffPanel).toContainText("#1");
  await expect(diffPanel).toContainText("#2");
  await expect(diffPanel).not.toContainText("(current)");

  await diffPanel.getByRole("button", { name: "Close diff" }).click();
  await expect(diffPanel).toBeHidden();
});
