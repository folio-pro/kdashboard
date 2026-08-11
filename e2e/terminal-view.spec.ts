/**
 * Regression: after migrating the terminal from xterm.js to wterm, the panel
 * could sit on its placeholder forever — the user saw a "loading" state and
 * could never type.
 *
 * WTerm.init() is async (it instantiates a WASM core), unlike xterm's
 * synchronous open(). Every failure on that path was silent: if the host node
 * was not bound yet initTerminal() returned early and connect() bailed at
 * `if (!terminal) return`, and if init() rejected the error escaped connect()
 * as an unhandled promise. Either way terminalReady stayed false with nothing
 * logged or rendered.
 *
 * This boots straight into a terminal tab and asserts the emulator actually
 * mounts, renders its grid, and reaches the connected state.
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const POD_NAME = "demo-pod";

const SEED_TABS = {
  version: 1,
  tabs: [
    {
      id: "tab-terminal-1",
      type: "terminal",
      label: POD_NAME,
      closable: true,
      resourceName: POD_NAME,
      resourceType: "Pod",
      namespace: "default",
    },
  ],
  activeTabId: "tab-terminal-1",
};

const MOCK = clusterBootMock(`(cmd) => {
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
  // start_terminal_exec / resize_terminal / send_terminal_input all resolve to
  // null via the boot mock's fallthrough, which is what the real backend
  // returns on success.
}`);

test.describe("TerminalView (wterm)", () => {
  test.beforeEach(async ({ page, mockInvoke }) => {
    await mockInvoke(MOCK);
    await page.addInitScript(
      `window.localStorage.setItem("kdashboard-tabs-v1", '${JSON.stringify(SEED_TABS)}');`,
    );
  });

  test("mounts the emulator and renders its grid", async ({ page }) => {
    await page.goto("/");

    const panel = page.locator('[data-testid="terminal-panel"]');
    await expect(panel).toBeVisible();

    // WTerm adds .wterm to its host element only after init() resolves.
    const term = panel.locator(".wterm");
    await expect(term).toBeVisible({ timeout: 15000 });

    // The renderer built a grid — proves the WASM core initialised, not just
    // that the class was attached.
    await expect(panel.locator(".term-row").first()).toBeAttached();
    expect(await panel.locator(".term-row").count()).toBeGreaterThan(0);

    // The init-failure fallback must not be showing.
    await expect(panel.getByText(/Terminal failed to start/)).toHaveCount(0);
  });

  test("auto-connects and accepts keyboard input", async ({ page }) => {
    const sent: string[] = [];
    await page.exposeFunction("__recordInput", (data: string) => {
      sent.push(data);
    });
    await page.addInitScript(`
      window.addEventListener("DOMContentLoaded", () => {
        const api = window.electronAPI;
        const original = api.invoke;
        api.invoke = async (cmd, args) => {
          if (cmd === "send_terminal_input") window.__recordInput(args.data);
          return original(cmd, args);
        };
      });
    `);

    await page.goto("/");

    const panel = page.locator('[data-testid="terminal-panel"]');
    await expect(panel.locator(".wterm")).toBeVisible({ timeout: 15000 });

    // The container effect selects "main" and auto-starts the session.
    await expect(panel.getByText("CONNECTED")).toBeVisible({ timeout: 15000 });

    await panel.locator(".wterm").click();
    await page.keyboard.type("ls");

    await expect.poll(() => sent.join(""), { timeout: 5000 }).toContain("ls");
  });

  /**
   * Regression: output scrolled out of view. wterm's _scrollToBottom() rounds
   * scrollTop down to a whole row, and its _isScrolledToBottom() probe uses a
   * 5px tolerance — so the sub-row remainder read as "user scrolled up" and
   * auto-scroll switched off permanently after the first scrollback line.
   */
  test("follows output as it scrolls past the viewport", async ({ page }) => {
    // Capture the terminal-output subscription so the test can push PTY chunks.
    await page.addInitScript(`
      window.addEventListener("DOMContentLoaded", () => {
        const api = window.electronAPI;
        const handlers = {};
        api.on = (channel, fn) => { (handlers[channel] ||= []).push(fn); };
        api.off = (channel, fn) => {
          handlers[channel] = (handlers[channel] || []).filter((h) => h !== fn);
        };
        window.__emit = (channel, payload) => {
          for (const h of handlers[channel] || []) h({}, payload);
        };
      });
    `);

    await page.goto("/");

    const panel = page.locator('[data-testid="terminal-panel"]');
    const term = panel.locator(".wterm");
    await expect(term).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText("CONNECTED")).toBeVisible({ timeout: 15000 });

    // Far more lines than fit, so the grid overflows into scrollback.
    await page.evaluate(() => {
      let chunk = "";
      for (let i = 0; i < 200; i++) chunk += `line-${i}\r\n`;
      window.__emit("terminal-output", chunk);
    });
    await page.waitForTimeout(600);

    const pos = await term.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    // There must be something to scroll, and we must be pinned to the bottom.
    expect(pos.scrollHeight).toBeGreaterThan(pos.clientHeight);
    expect(pos.scrollHeight - pos.scrollTop - pos.clientHeight).toBeLessThanOrEqual(1);
  });
});
