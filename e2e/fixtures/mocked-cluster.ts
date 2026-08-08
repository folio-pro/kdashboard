/**
 * Playwright fixture that replaces the Electron IPC bridge (window.electronAPI,
 * exposed by electron/preload.ts) with a user-supplied handler. The replacement
 * happens before any app script runs so the very first invoke() call the app
 * makes on boot is intercepted.
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
 *   test("cluster unreachable shows overlay", async ({ page, mockInvoke }) => {
 *     await mockInvoke(`(cmd) => {
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
  mockInvoke: (handlerSource: string) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  mockInvoke: async ({ page }, use) => {
    const install = async (handlerSource: string) => {
      await page.addInitScript(`
        (function () {
          const handler = ${handlerSource};
          const fakeInvoke = async (cmd, args) => {
            try {
              const result = handler(cmd, args ?? {});
              return result && typeof result.then === "function" ? await result : result;
            } catch (err) {
              // Reject with a string so callers see a stable shape (the UI was
              // written to read string error messages off the IPC boundary).
              throw String(err instanceof Error ? err.message : err);
            }
          };
          // Mirror the preload-exposed bridge (electron/preload.ts). on/off are
          // no-ops — the mock never emits backend events.
          Object.defineProperty(window, "electronAPI", {
            value: {
              invoke: fakeInvoke,
              on: () => {},
              off: () => {},
              openExternal: async () => {},
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

/**
 * Compose a mock handler that answers the app's boot-sequence commands
 * (contexts, namespaces, counts, bench config) and delegates everything else
 * to `extraSource`. Like all mockInvoke handlers, `extraSource` must be a
 * self-contained function-source string — it is serialized into the page.
 * Return `undefined` from it for commands you don't care about (mapped to
 * null, the "unhandled command" convention of these mocks).
 */
export function clusterBootMock(extraSource = "() => undefined"): string {
  return `(cmd, args) => {
    if (cmd === "get_contexts") return ["bench"];
    if (cmd === "get_current_context") return "bench";
    if (cmd === "get_namespaces") return ["default"];
    if (cmd === "get_resource_counts") return {};
    if (cmd === "bench_config") return { enabled: false };
    const result = (${extraSource})(cmd, args);
    return result === undefined ? null : result;
  }`;
}
