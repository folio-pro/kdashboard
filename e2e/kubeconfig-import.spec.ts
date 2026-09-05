/**
 * Settings → Kubernetes: import (merge) another kubeconfig with a preview, and
 * remove a non-active context from the file.
 */
import { test, expect } from "./fixtures/mocked-cluster";

// Standalone handler (not clusterBootMock): the boot mock pins get_contexts to
// ["bench"], and the removal flow needs a second, non-active context.
const MOCK = `(cmd, args) => {
  if (cmd === "get_contexts") return ["bench", "legacy"];
  if (cmd === "get_current_context") return "bench";
  if (cmd === "get_namespaces") return ["default"];
  if (cmd === "get_resource_counts") return {};
  if (cmd === "bench_config") return { enabled: false };
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "preview_kubeconfig") {
    window.__preview = args;
    return {
      file: "/home/me/.kube/config",
      source: "pasted kubeconfig",
      rows: [
        { name: "prod-eu", cluster: "prod", user: "me", server: "https://prod.example:6443", namespace: "payments", status: "new" },
        { name: "bench", cluster: "bench", user: "me", server: "https://bench:6443", status: "identical" },
        { name: "legacy", cluster: "legacy", user: "me", server: "https://legacy-NEW:6443", status: "conflict" },
      ],
    };
  }
  if (cmd === "import_kubeconfig") {
    window.__import = args;
    return { file: "/home/me/.kube/config", backup: "/home/me/.kube/config.kdash-backup-1", contexts: { added: ["prod-eu"], replaced: [], skipped: ["legacy"] }, clusters: { added: ["prod"], replaced: [], skipped: [] }, users: { added: [], replaced: [], skipped: ["me"] } };
  }
  if (cmd === "remove_kubeconfig_context") { window.__removed = args; return { file: "/home/me/.kube/config", backup: "b", removedCluster: "legacy", removedUser: null }; }
  if (cmd === "save_settings") return null;
  if (cmd === "discover_crds") return [];
  return null;
}`;

const YAML = "apiVersion: v1\nkind: Config\ncontexts:\n  - name: prod-eu\n    context: {cluster: prod, user: me}\n";

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Kubernetes" }).click();
  await expect(page.locator('[data-testid="kubeconfig-import"]')).toBeVisible();
});

test("previews a pasted kubeconfig and imports the selected contexts", async ({ page }) => {
  await page.getByLabel("Kubeconfig YAML to import").fill(YAML);
  await page.locator('[data-testid="kubeconfig-preview"]').click();

  const rows = page.locator('[data-testid="kubeconfig-preview-rows"]');
  await expect(rows).toContainText("3 contexts");
  await expect(rows).toContainText("prod-eu");
  await expect(rows).toContainText("https://prod.example:6443 · ns payments");
  await expect(rows.getByText("new", { exact: true })).toBeVisible();
  await expect(rows.getByText("identical", { exact: true })).toBeVisible();
  await expect(rows.getByText("conflict", { exact: true })).toBeVisible();
  // Identical rows are not selectable; the two that would change are preselected.
  await expect(rows.locator('[data-testid="kubeconfig-import-run"]')).toContainText("Import 2 contexts");

  await rows.getByText("Overwrite conflicting entries").click();
  await rows.locator('[data-testid="kubeconfig-import-run"]').click();
  await expect(page.getByText("Kubeconfig updated")).toBeVisible();
  await expect(page.getByText(/1 context added/)).toBeVisible();
  const sent = await page.evaluate(() => (window as unknown as { __import: Record<string, unknown> }).__import);
  expect(sent).toMatchObject({ content: YAML, overwrite: true });
  expect((sent.contexts as string[]).sort()).toEqual(["legacy", "prod-eu"]);
  await expect(page.locator('[data-testid="kubeconfig-preview-rows"]')).toHaveCount(0);
});

test("the active context cannot be removed; another one can, after confirming", async ({ page }) => {
  const contexts = page.locator("section", { has: page.getByRole("heading", { name: "Contexts" }) });
  // Expand the active context: its remove button is disabled.
  await contexts.getByRole("button", { name: /bench/ }).first().click();
  await expect(contexts.locator('[data-testid="remove-context"]')).toBeDisabled();
  // Collapse it, expand the other one and remove that.
  await contexts.getByRole("button", { name: /bench/ }).first().click();
  await contexts.getByRole("button", { name: /legacy/ }).first().scrollIntoViewIfNeeded();
  await contexts.getByRole("button", { name: /legacy/ }).first().click();
  await contexts.locator('[data-testid="remove-context"]').click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Context removed")).toBeVisible();
  const removed = await page.evaluate(() => (window as unknown as { __removed: Record<string, unknown> }).__removed);
  expect(removed).toEqual({ context: "legacy" });
});
