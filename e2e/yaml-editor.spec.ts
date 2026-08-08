/**
 * Regression: the YAML sub-tab rendered an empty panel — CodeMirror's
 * EditorState.create threw "Unrecognized extension value" because two copies
 * of @codemirror/state were bundled (a stale nested copy under codemirror/ and
 * @codemirror/lang-yaml). The throw happened inside a requestAnimationFrame
 * callback, so the editor silently never mounted.
 *
 * Fixed by removing the conflicting package.json override, deduping the
 * dependency tree, and adding resolve.dedupe for @codemirror/* in both vite
 * configs. This test fails if duplicate CodeMirror instances ever reappear.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const SEED_TABS = {
  version: 1,
  tabs: [
    {
      id: "tab-1",
      type: "table",
      label: "Pods",
      closable: true,
      resourceType: "pods",
      namespace: "default",
    },
  ],
  activeTabId: "tab-1",
};

const POD = `{
  kind: "Pod", api_version: "v1",
  metadata: { name: "demo-pod", namespace: "default", uid: "u-pod-1", creation_timestamp: "2024-01-01T00:00:00Z", resource_version: "1" },
  spec: { nodeName: "node-1", containers: [{ name: "main", image: "nginx:1.27" }] },
  status: { phase: "Running" },
}`;

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "discover_crds") return [];
  if (cmd === "get_events" || cmd === "get_resource_events") return [];
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [${POD}] };
  if (cmd === "get_resource") return ${POD};
  if (cmd === "get_resource_yaml") {
    return "apiVersion: v1\\nkind: " + args.kind + "\\nmetadata:\\n  name: " + args.name + "\\n";
  }
}`);

test("YAML sub-tab mounts the CodeMirror editor with the fetched YAML", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.addInitScript(
    `window.localStorage.setItem("kdashboard-tabs-v1", '${JSON.stringify(SEED_TABS)}');`,
  );
  await page.goto("/");

  const row = page.getByRole("row", { name: /demo-pod/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  const yamlTab = page.getByRole("button", { name: "YAML", exact: true });
  await expect(yamlTab).toBeVisible({ timeout: 5_000 });
  await yamlTab.click();

  await expect(page.locator(".cm-content").first()).toContainText("kind: Pod", { timeout: 10_000 });
});
