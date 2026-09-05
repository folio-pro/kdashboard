/**
 * Quick Edit: change a Deployment's image, env and requests from a form, review
 * the change list and the resulting YAML, apply through apply_yaml.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const DEPLOYMENT = {
  kind: "Deployment", api_version: "apps/v1",
  metadata: { name: "web", namespace: "default", uid: "d1", creation_timestamp: new Date().toISOString(), labels: {}, annotations: {}, owner_references: [], resource_version: "1" },
  spec: { replicas: 1, selector: { matchLabels: { app: "web" } }, template: { spec: { containers: [{ name: "app", image: "acme/web:1.4.0" }] } } },
  status: { replicas: 1, readyReplicas: 1 },
};
const YAML = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: default\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - name: app\n          image: acme/web:1.4.0\n          env:\n            - name: LOG_LEVEL\n              value: info\n          resources:\n            requests:\n              cpu: 500m\n";

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: args.resourceType === "deployments" ? [${JSON.stringify(DEPLOYMENT)}] : [] };
  if (cmd === "get_resource_yaml") return ${JSON.stringify(YAML)};
  if (cmd === "apply_yaml") { window.__applied = args.yaml; return "ok"; }
  if (cmd === "discover_crds") return [];
}`);

test("edits image, env and requests from the form and applies the resulting YAML", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Deployments / }).first().click();
  await expect(page.getByRole("heading", { name: "Deployments", exact: true })).toBeVisible();

  await page.locator("tbody tr").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Quick Edit..." }).click();
  const dialog = page.locator('[data-testid="quick-edit"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Image")).toHaveValue("acme/web:1.4.0");
  await expect(dialog.getByLabel("Env value 1")).toHaveValue("info");

  await dialog.getByLabel("Image").fill("acme/web:1.5.0");
  await dialog.getByLabel("Env value 1").fill("debug");
  await dialog.locator('[data-testid="quick-edit-add-env"]').click();
  await dialog.getByLabel("Env name 2").fill("FEATURE_X");
  await dialog.getByLabel("Env value 2").fill("on");
  await dialog.getByLabel("CPU request").fill("250m");
  await dialog.getByLabel("Memory limit").fill("1Gi");
  await expect(dialog).toContainText("5 changes");

  await dialog.locator('[data-testid="quick-edit-review"]').click();
  const changes = dialog.locator('[data-testid="quick-edit-changes"]');
  await expect(changes).toContainText("app: image acme/web:1.4.0 → acme/web:1.5.0");
  await expect(changes).toContainText("app: env LOG_LEVEL changed");
  await expect(changes).toContainText("app: env FEATURE_X added");
  await expect(changes).toContainText("app: CPU request 500m → 250m");
  await expect(changes).toContainText("app: memory limit unset → 1Gi");
  await expect(dialog.locator('[data-testid="quick-edit-preview"]')).toContainText("image: acme/web:1.5.0");

  await dialog.locator('[data-testid="quick-edit-apply"]').click();
  await expect(page.getByText("Applied")).toBeVisible();
  const applied = await page.evaluate(() => (window as unknown as { __applied: string }).__applied);
  expect(applied).toContain("image: acme/web:1.5.0");
  expect(applied).toContain("name: FEATURE_X");
  expect(applied).toContain("cpu: 250m");
  expect(applied).toContain("memory: 1Gi");
  expect(applied).toContain("replicas: 1");
});
