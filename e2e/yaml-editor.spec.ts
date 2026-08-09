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
  // No cluster schema here, so the editor exercises its static-schema fallback.
  if (cmd === "get_openapi_schema") {
    return { available: false, root: null, schemas: {}, reason: "mocked" };
  }
  if (cmd === "get_resource_yaml") {
    return "apiVersion: v1\\nkind: " + args.kind + "\\nmetadata:\\n  name: " + args.name + "\\n";
  }
}`);

/** Open the Pod's YAML sub-tab and wait for CodeMirror to mount. */
async function openYamlTab(
  page: import("@playwright/test").Page,
  mockInvoke: (mock: string) => Promise<void>,
) {
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

  const content = page.locator(".cm-content").first();
  await expect(content).toContainText("kind: Pod", { timeout: 10_000 });
  return content;
}

test("YAML sub-tab mounts the CodeMirror editor with the fetched YAML", async ({ page, mockInvoke }) => {
  await openYamlTab(page, mockInvoke);
});

/**
 * The mocked Pod has no `spec`, which the schema marks required. Seeing the
 * warning proves the whole diagnostic path is wired: parse -> schema lookup ->
 * CodeMirror lint state -> gutter and header.
 */
test("schema diagnostics surface in the gutter and the header", async ({ page, mockInvoke }) => {
  await openYamlTab(page, mockInvoke);

  await expect(page.locator(".cm-gutter-lint .cm-lint-marker").first()).toBeVisible({
    timeout: 10_000,
  });

  const chip = page.getByRole("button", { name: /Show problems/ }).first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
});

test("the problem chip opens the lint panel", async ({ page, mockInvoke }) => {
  await openYamlTab(page, mockInvoke);

  const chip = page.getByRole("button", { name: /Show problems/ }).first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();

  const panel = page.locator(".cm-panel-lint");
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(panel).toContainText(/spec/i);
});

/**
 * An invalid enum must be underlined on the value the user wrote. This is the
 * end-to-end form of the anchoring regression covered in yaml-lint.test.ts.
 */
test("an invalid enum value is underlined inline", async ({ page, mockInvoke }) => {
  const content = await openYamlTab(page, mockInvoke);

  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("spec:\n");
  // The editor auto-indents after a mapping key, so the container list lines up.
  await page.keyboard.type("restartPolicy: Sometimes\n");

  await expect(page.locator(".cm-lintRange-warning").first()).toBeVisible({ timeout: 10_000 });
});

test("Ctrl+Space offers schema-driven completions", async ({ page, mockInvoke }) => {
  const content = await openYamlTab(page, mockInvoke);

  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("spe");
  await page.keyboard.press("Control+Space");

  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText("spec");
});
