/**
 * Regression: deleting a multi-selection from the row CONTEXT MENU used to
 * delete immediately, while the BulkActionBar button asked for confirmation
 * first. Both entry points must confirm before deleting anything.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";
import { tableRows } from "./helpers";

const POD = (i: number) => ({
  kind: "Pod",
  api_version: "v1",
  metadata: {
    name: `pod-${i}`,
    namespace: "default",
    uid: `uid-${i}`,
    creation_timestamp: new Date(Date.now() - i * 60_000).toISOString(),
    labels: {},
    annotations: {},
    owner_references: [],
    resource_version: String(i),
  },
  spec: { containers: [{ name: "app", image: "nginx:1.27" }] },
  status: { phase: "Running" },
});

const PODS = [POD(1), POD(2), POD(3)];

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, resource_version: "1", items: args.resourceType === "pods" ? ${JSON.stringify(PODS)} : [] };
  if (cmd === "delete_resource") { window.__deleted = (window.__deleted || []).concat(args.name); return "ok"; }
  if (cmd === "discover_crds") return [];
  if (cmd === "get_resource_events") return [];
  if (cmd === "get_pod_metrics") return { available: false, reason: "mock", pods: [] };
}`);

test("context-menu bulk delete confirms before deleting", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  // Select two rows (checkbox chrome mounts on hover).
  await tableRows(page).nth(0).hover();
  await tableRows(page).nth(0).locator('[data-testid="row-checkbox"]').click({ force: true });
  await tableRows(page).nth(1).hover();
  await tableRows(page).nth(1).locator('[data-testid="row-checkbox"]').click({ force: true });
  await expect(page.getByText("2 resources selected")).toBeVisible();

  // Right-click a selected row → bulk menu → Delete.
  await tableRows(page).nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();

  // Confirmation first, and nothing deleted yet.
  const confirm = page.getByRole("button", { name: "Delete 2 resources" });
  await expect(confirm).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __deleted?: string[] }).__deleted ?? [])).toEqual([]);

  // Confirming deletes exactly the two selected — by identity, not by count:
  // deleting the wrong row, or one row twice, has to fail here too.
  await confirm.click();
  await expect
    .poll(async () =>
      page.evaluate(() => [...((window as unknown as { __deleted?: string[] }).__deleted ?? [])].sort()),
    )
    .toEqual(["pod-1", "pod-2"]);
});
