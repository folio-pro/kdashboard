/**
 * Security → Permissions: pick a subject, read its effective permissions, and
 * ask a quick "can it VERB RESOURCE in NAMESPACE?" answered locally.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const SUBJECTS = [
  { kind: "ServiceAccount", name: "ci", namespace: "billing", bindings: 2 },
  { kind: "User", name: "alice", namespace: null, bindings: 1 },
  { kind: "Group", name: "platform-admins", namespace: null, bindings: 1 },
];
const PERMS = {
  subject: { kind: "ServiceAccount", name: "ci", namespace: "billing" },
  groups: ["system:serviceaccounts", "system:serviceaccounts:billing", "system:authenticated"],
  grants: [
    { scope: "cluster", binding_kind: "ClusterRoleBinding", binding: "sa-viewers", role_kind: "ClusterRole", role: "view", via: { kind: "Group", name: "system:serviceaccounts:billing" }, rules: [{ api_groups: ["", "apps"], resources: ["pods", "deployments"], verbs: ["get", "list", "watch"], resource_names: [], non_resource_urls: [] }] },
    { scope: "billing", binding_kind: "RoleBinding", binding: "ci-deploys", role_kind: "Role", role: "deployer", via: { kind: "ServiceAccount", name: "ci" }, rules: [{ api_groups: ["apps"], resources: ["deployments"], verbs: ["update", "patch"], resource_names: [], non_resource_urls: [] }] },
  ],
  rows: [
    { api_group: "", resource: "pods", verbs: ["get", "list", "watch"], scopes: ["cluster"], resource_names: null },
    { api_group: "apps", resource: "deployments", verbs: ["get", "list", "watch", "update", "patch"], scopes: ["cluster", "billing"], resource_names: null },
  ],
  cluster_admin: false,
  missing_roles: [],
};
const ADMIN = { ...PERMS, subject: { kind: "User", name: "alice", namespace: null }, groups: ["system:authenticated"], cluster_admin: true, grants: [{ scope: "cluster", binding_kind: "ClusterRoleBinding", binding: "admins", role_kind: "ClusterRole", role: "cluster-admin", via: { kind: "User", name: "alice" }, rules: [{ api_groups: ["*"], resources: ["*"], verbs: ["*"], resource_names: [], non_resource_urls: [] }] }], rows: [{ api_group: "*", resource: "*", verbs: ["*"], scopes: ["cluster"], resource_names: null }] };

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "get_security_overview") return { pods: [], total_vulns: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, total_images_scanned: 0, compliant_pods: 0, non_compliant_pods: 0, scanner: "none", fetched_at: "" };
  if (cmd === "get_rbac_subjects") return ${JSON.stringify(SUBJECTS)};
  if (cmd === "get_effective_permissions") { window.__rbacArgs = args; return args.name === "alice" ? ${JSON.stringify(ADMIN)} : ${JSON.stringify(PERMS)}; }
  if (cmd === "discover_crds") return [];
}`);

test("resolves a service account, answers can-i locally and flags cluster-admin", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /^Security/ }).first().click();
  await page.locator('[data-testid="security-mode-permissions"]').click();
  const panel = page.locator('[data-testid="rbac"]');
  await expect(panel).toBeVisible();
  const subjects = panel.locator('[data-testid="rbac-subject"]');
  await expect(subjects).toHaveCount(3);

  await subjects.filter({ hasText: "billing/ci" }).click();
  const summary = panel.locator('[data-testid="rbac-summary"]');
  await expect(summary).toContainText("sa billing/ci");
  await expect(summary).toContainText("2 grants · 2 resources");
  const sent = await page.evaluate(() => (window as unknown as { __rbacArgs: Record<string, unknown> }).__rbacArgs);
  expect(sent).toMatchObject({ kind: "ServiceAccount", name: "ci", subjectNamespace: "billing" });

  const rows = panel.locator('[data-testid="rbac-row"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("deployments.apps");
  await expect(rows.nth(1)).toContainText("cluster, billing");

  // Quick check: patch deployments in billing → yes via the Role; in shop → no.
  await panel.getByLabel("Verb", { exact: true }).selectOption("patch");
  await panel.getByLabel("Resource", { exact: true }).fill("deployments.apps");
  await panel.getByLabel("Namespace", { exact: true }).fill("billing");
  await expect(panel.locator('[data-testid="rbac-check-result"]')).toContainText("yes — via Role/deployer");
  await panel.getByLabel("Namespace", { exact: true }).fill("shop");
  await expect(panel.locator('[data-testid="rbac-check-result"]')).toContainText("no");

  // Filter the matrix.
  await panel.getByLabel("Filter resources").fill("pods");
  await expect(rows).toHaveCount(1);

  // A cluster-admin is flagged as such.
  await subjects.filter({ hasText: "alice" }).click();
  await expect(summary).toContainText("cluster-admin");
});
