/**
 * Global Events view: a kubectl-style cluster event feed backed by the same
 * registry-driven table as every other resource type. Guards the pieces that
 * are unique to events — the synthetic-spec columns, the newest-first default
 * sort (there is no Name column to fall back to), and reason/message filtering.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

function mockEvent(
  name: string,
  minutesAgo: number,
  type: string,
  reason: string,
  message: string,
  object: { kind: string; name: string },
) {
  return {
    kind: "Event",
    api_version: "v1",
    metadata: {
      name,
      namespace: "default",
      uid: `event-uid-${name}`,
      creation_timestamp: iso(minutesAgo),
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    // list projection lifts the Event's top-level fields into a synthetic spec
    spec: {
      type,
      reason,
      message,
      count: 2,
      involvedObject: object,
      lastTimestamp: iso(minutesAgo),
    },
  };
}

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources" && args.resourceType === "events") {
    return { resource_type: "events", items: ${JSON.stringify([
      mockEvent("old-pull", 60, "Normal", "Pulled", "Container image pulled", { kind: "Pod", name: "web-1" }),
      mockEvent("fresh-backoff", 1, "Warning", "BackOff", "Back-off restarting failed container", { kind: "Pod", name: "web-0" }),
      mockEvent("mid-schedule", 30, "Normal", "Scheduled", "Successfully assigned default/web-1", { kind: "Pod", name: "web-1" }),
    ])} };
  }
  if (cmd === "list_resources" && args.resourceType === "pods") {
    return { resource_type: "pods", items: [{
      kind: "Pod",
      api_version: "v1",
      metadata: {
        name: "web-0", namespace: "default", uid: "pod-uid-web-0",
        creation_timestamp: ${JSON.stringify(iso(120))},
        labels: {}, annotations: {}, owner_references: [], resource_version: "1",
      },
      spec: { nodeName: "node-1", containers: [{ name: "web", image: "nginx" }] },
      status: { phase: "Running" },
    }] };
  }
  if (cmd === "list_resources") return { items: [], columns: [] };
  if (cmd === "discover_crds") return [];
}`);

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Events/ }).first().click();
  await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
});

test("lists events with kubectl-style columns, newest first", async ({ page }) => {
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);

  // Default sort is eventLastSeen "asc" = most recent activity on top.
  await expect(rows.nth(0)).toContainText("BackOff");
  await expect(rows.nth(1)).toContainText("Scheduled");
  await expect(rows.nth(2)).toContainText("Pulled");

  // Event-specific columns render from the synthetic spec.
  await expect(rows.nth(0)).toContainText("Pod/web-0");
  await expect(rows.nth(0)).toContainText("Back-off restarting failed container");
  await expect(rows.nth(0)).toContainText("warning");
});

test("the Object column deep-links to the involved resource", async ({ page }) => {
  await page.getByRole("button", { name: "Pod/web-0" }).click();
  await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();
  await expect(page.locator('[data-testid="detail-panel"]')).toContainText("web-0");
});

test("filter matches event reason and message", async ({ page }) => {
  const filter = page.getByPlaceholder("Search events...");
  await filter.fill("backoff");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("BackOff");

  await filter.fill("assigned default");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("Scheduled");
});
