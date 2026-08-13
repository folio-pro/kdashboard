/**
 * Regression: the control bar under the logs and shell tabs lost its buttons
 * and its colour — the Stream/Connect actions rendered with no fill and the
 * log level filters all rendered the same colour.
 *
 * Asserts the painted result (computed styles), not the class list, so it goes
 * red for any cause: a missing variant, an ungenerated utility, a token that
 * never resolves.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const POD_NAME = "demo-pod";

const POD_MOCK = clusterBootMock(`(cmd) => {
  if (cmd === "get_resource") {
    return {
      kind: "Pod",
      api_version: "v1",
      metadata: {
        name: "${POD_NAME}",
        namespace: "default",
        uid: "u-demo-1",
        creation_timestamp: "2024-01-01T00:00:00Z",
        resource_version: "1",
        labels: { app: "demo" },
      },
      spec: { nodeName: "node-1", containers: [{ name: "main", image: "nginx:1.27" }] },
      status: {
        phase: "Running",
        podIP: "10.0.0.5",
        containerStatuses: [
          { name: "main", image: "nginx:1.27", ready: true, restartCount: 0, state: { running: { startedAt: "2024-01-01T00:00:00Z" } } },
        ],
      },
    };
  }
}`);

function seedTab(type: "logs" | "terminal") {
  return JSON.stringify({
    version: 1,
    tabs: [
      {
        id: `tab-${type}-1`,
        type,
        label: POD_NAME,
        closable: true,
        resourceName: POD_NAME,
        resourceType: "Pod",
        namespace: "default",
      },
    ],
    activeTabId: `tab-${type}-1`,
  });
}

const TRANSPARENT = ["rgba(0, 0, 0, 0)", "transparent"];

test.describe("control bar styling", () => {
  test("the logs control bar paints its buttons", async ({ page, mockInvoke }) => {
    await mockInvoke(POD_MOCK);
    await page.addInitScript(
      `window.localStorage.setItem("kdashboard-tabs-v1", '${seedTab("logs")}');`,
    );
    await page.goto("/");

    const panel = page.locator('[data-testid="log-viewer"]');
    await expect(panel).toBeVisible();

    // The primary action is filled in the success tone. No fill = invisible
    // button: its label is --bg-primary, the colour of the bar behind it.
    const stream = panel.getByRole("button", { name: /Stream|Stop/ });
    await expect(stream).toBeVisible();
    const streamBg = await stream.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(TRANSPARENT, `Stream button background: ${streamBg}`).not.toContain(streamBg);

    // Each level filter carries its own status colour at rest, so no two of
    // them may paint the same label colour.
    const levels = ["info", "warn", "error"];
    const colours = await Promise.all(
      levels.map((l) =>
        panel
          .getByRole("button", { name: l, exact: true })
          .evaluate((el) => getComputedStyle(el).color),
      ),
    );
    expect(new Set(colours).size, `level colours: ${colours.join(", ")}`).toBe(levels.length);

    // The recessed toolbar controls have a surface and a border.
    const clear = panel.getByRole("button", { name: "Clear logs" });
    const clearStyle = await clear.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderTopWidth, height: el.getBoundingClientRect().height };
    });
    expect(TRANSPARENT, `Clear button background: ${clearStyle.bg}`).not.toContain(clearStyle.bg);
    expect(clearStyle.border).not.toBe("0px");
    expect(clearStyle.height).toBe(28);
  });

  test("the shell control bar paints its buttons", async ({ page, mockInvoke }) => {
    await mockInvoke(POD_MOCK);
    await page.addInitScript(
      `window.localStorage.setItem("kdashboard-tabs-v1", '${seedTab("terminal")}');`,
    );
    await page.goto("/");

    const panel = page.locator('[data-testid="terminal-panel"]');
    await expect(panel).toBeVisible();

    const action = panel.getByRole("button", { name: /Connect|Disconnect/ });
    await expect(action).toBeVisible({ timeout: 15000 });
    const style = await action.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, height: el.getBoundingClientRect().height };
    });
    expect(TRANSPARENT, `Connect button background: ${style.bg}`).not.toContain(style.bg);
    expect(style.height).toBe(28);
  });
});
