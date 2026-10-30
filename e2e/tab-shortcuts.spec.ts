/**
 * Keyboard tab switching (#85): Ctrl+Tab / Ctrl+Shift+Tab cycle with
 * wrap-around, ⌘1…⌘8 jump to a position, ⌘9 to the last tab.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const MOCK = clusterBootMock(`(cmd) => {
  if (cmd === "list_resources") return { items: [], columns: [] };
  if (cmd === "discover_crds") return [];
}`);

test("keyboard shortcuts switch between tabs and wrap around", async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });

  // Three tabs: Pods, Deployments, Port Forwards (active).
  await page.getByRole("button", { name: /^Deployments/ }).first().click();
  await expect(page.getByRole("heading", { name: "Deployments", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Port Forwards/ }).first().click();
  await expect(page.getByText("No active port forwards")).toBeVisible();

  // The tab bar's tabs carry data-tab-id; other tablists on the page don't.
  const tabs = page.locator("[role=tab][data-tab-id]");
  await expect(tabs).toHaveCount(3);
  const activeIndex = () =>
    tabs.evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-selected") === "true"));

  expect(await activeIndex()).toBe(2);

  await page.keyboard.press("Control+Tab"); // wraps last → first
  await expect.poll(activeIndex).toBe(0);
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible();

  await page.keyboard.press("Control+Tab");
  await expect.poll(activeIndex).toBe(1);

  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(activeIndex).toBe(0);

  await page.keyboard.press("Control+Shift+Tab"); // wraps first → last
  await expect.poll(activeIndex).toBe(2);

  await page.keyboard.press("ControlOrMeta+2");
  await expect.poll(activeIndex).toBe(1);
  await expect(page.getByRole("heading", { name: "Deployments", exact: true })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+9");
  await expect.poll(activeIndex).toBe(2);

  await page.keyboard.press("ControlOrMeta+Shift+BracketRight"); // wraps
  await expect.poll(activeIndex).toBe(0);

  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect.poll(activeIndex).toBe(2);

  // Out of range is a no-op.
  await page.keyboard.press("ControlOrMeta+5");
  await expect.poll(activeIndex).toBe(2);
});
