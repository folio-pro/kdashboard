/**
 * Compare Across Namespaces: right-click a namespaced resource, pick a target
 * namespace, and get a read-only CodeMirror MergeView of the two YAMLs.
 */
import { test, expect } from "./fixtures/mocked-cluster";

function mockPod(name: string, namespace: string) {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid: `pod-uid-${namespace}-${name}`,
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: { nodeName: "node-1", containers: [{ name: "web", image: "nginx:1.0" }] },
    status: { phase: "Running" },
  };
}

// Standalone handler (not clusterBootMock): the boot mock pins get_namespaces
// to ["default"], and this flow needs a second namespace to diff against.
const MOCK = `(cmd, args) => {
  if (cmd === "get_contexts") return ["bench", "prod-eu"];
  if (cmd === "get_current_context") return "bench";
  if (cmd === "get_namespaces") return ["default", "staging"];
  if (cmd === "get_resource_counts") return {};
  if (cmd === "bench_config") return { enabled: false };
  if (cmd === "list_resources" && args.resourceType === "pods") {
    return { resource_type: "pods", items: [${JSON.stringify(mockPod("web-0", "default"))}] };
  }
  if (cmd === "list_resources") return { items: [], columns: [] };
  if (cmd === "get_resource_yaml") {
    if (args.context === "prod-eu") return "image: nginx:3.0\\nreplicas: 9\\ncontext: " + args.context + "/" + args.namespace + "\\n";
    if (args.namespace === "staging") return "image: nginx:2.0\\nreplicas: 3\\n";
    return "image: nginx:1.0\\nreplicas: 1\\n";
  }
  if (cmd === "discover_crds") return [];
  return null;
}`;

test("diffs a resource against its sibling in another namespace", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.locator("tbody tr").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Compare Across Namespaces/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Compare Pod");
  // "staging" is the only other namespace, so it is preselected.
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();

  // Both sides of the MergeView render their YAML.
  await expect(dialog).toContainText("nginx:1.0");
  await expect(dialog).toContainText("nginx:2.0");
});

test("diffs a resource against the same namespace in another context", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.locator("tbody tr").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Compare Across Namespaces/ }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Target context/ }).click();
  await page.getByText("prod-eu", { exact: true }).last().click();
  // Across contexts the namespace is free text, prefilled with the source's.
  await expect(dialog.getByLabel("Target namespace")).toHaveValue("default");
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();

  await expect(dialog).toContainText("nginx:1.0");
  await expect(dialog).toContainText("nginx:3.0");
  await expect(dialog).toContainText("prod-eu/default");
});
