/**
 * Playwright fixture that replaces Tauri's IPC bridge with a user-supplied
 * handler. The replacement happens before any app script runs so the very first
 * invoke() call the app makes on boot is intercepted.
 *
 * This mocks the whole Kubernetes backend surface so the frontend can be tested
 * against synthetic cluster states (connection failures, empty clusters,
 * specific error paths) without spinning up a real cluster.
 *
 * The handler is serialized into the page via addInitScript, so it must be
 * self-contained: any variables it closes over in TypeScript will be lost when
 * the function is stringified. Prefer inline handlers that pattern-match on
 * cmd and return plain data.
 *
 * Usage:
 *
 *   import { test, expect } from "./fixtures/mocked-cluster";
 *
 *   test("cluster unreachable shows overlay", async ({ page, mockTauriInvoke }) => {
 *     await mockTauriInvoke(`(cmd) => {
 *       if (cmd === "get_contexts") throw new Error("dial tcp: no route to host");
 *       return null;
 *     }`);
 *     await page.goto("/");
 *     await expect(page.getByText("Cluster connection lost")).toBeVisible();
 *   });
 */

import { test as base, type Page } from "@playwright/test";

export { expect } from "@playwright/test";

export type MockInvokeHandler = (cmd: string, args: Record<string, unknown>) => unknown;

interface Fixtures {
  page: Page;
  mockTauriInvoke: (handlerSource: string) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  mockTauriInvoke: async ({ page }, use) => {
    const install = async (handlerSource: string) => {
      await page.addInitScript(`
        (function () {
          const handler = ${handlerSource};
          const fakeInvoke = async (cmd, args) => {
            try {
              const result = handler(cmd, args ?? {});
              return result && typeof result.then === "function" ? await result : result;
            } catch (err) {
              // Propagate as a string so callers see a stable shape — matches
              // real Tauri behavior where errors cross the IPC boundary as
              // serialized strings, not Error instances.
              throw String(err instanceof Error ? err.message : err);
            }
          };
          Object.defineProperty(window, "__TAURI_INTERNALS__", {
            value: {
              invoke: fakeInvoke,
              // Tauri plugins register event callbacks via transformCallback.
              // Returning a stable id is enough — we are not firing events
              // from the mock.
              transformCallback: () => 0,
              metadata: { plugins: {} },
            },
            writable: true,
            configurable: true,
          });
        })();
      `);
    };
    await use(install);
  },
});
