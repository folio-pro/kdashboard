/**
 * User extensions: a module discovered by the main process is evaluated,
 * activated before the app mounts, and shows up in the palette and in
 * Settings → Extensions (with a broken one reported, not fatal).
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const GOOD = `export default { activate(ctx) {
  ctx.registerCommand({ id: "hello.say", label: "Say hello from extension", category: "Extensions", action: () => ctx.toast.success("Hello from " + ctx.id, "in " + ctx.cluster.context) });
  ctx.registerKbdHint({ id: "hello.hint", key: "H", label: "hello" });
} };`;

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
  if (cmd === "list_extensions") return { dir: "/home/me/.config/kdashboard/extensions", extensions: [
    { manifest: { id: "hello", name: "Hello", version: "0.1.0", description: "Says hello", main: "index.js", api: 1 }, dir: "/home/me/.config/kdashboard/extensions/hello", source: ${JSON.stringify(GOOD)}, error: null },
    { manifest: { id: "broken", name: "Broken", version: "0.0.1", main: "index.js", api: 1 }, dir: "/home/me/.config/kdashboard/extensions/broken", source: "export default { activate() { throw new Error('nope') } }", error: null },
    { manifest: null, dir: "/home/me/.config/kdashboard/extensions/bad-manifest", source: null, error: "bad-manifest: manifest needs a \\"name\\"" },
  ] };
  if (cmd === "discover_crds") return [];
}`);

test("loads a user extension before mount and reports broken ones", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  // The command it registered is in the palette and runs with the context.
  await page.keyboard.press("Meta+k");
  await page.locator('[data-testid="command-input"]').fill("Say hello");
  const item = page.locator('[data-testid="command-item"]', { hasText: "Say hello from extension" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByText("Hello from hello")).toBeVisible();

  // Settings → Extensions lists all three with their states.
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Extensions" }).click();
  const rows = page.locator('[data-testid="extension-row"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Hello");
  await expect(rows.nth(0)).toContainText("active");
  await expect(rows.nth(0)).toContainText("command Say hello from extension, hint hello");
  await expect(rows.nth(1)).toContainText("failed");
  await expect(rows.nth(1)).toContainText("nope");
  await expect(rows.nth(2)).toContainText("invalid");
  await expect(rows.nth(2)).toContainText('manifest needs a "name"');
});
