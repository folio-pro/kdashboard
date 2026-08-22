import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "./api";
import { loadExtensions, moduleOf, type ExtensionSource } from "./loader";

const src = (id: string, source = "x", api = 1): ExtensionSource => ({
  ok: true,
  manifest: { id, name: id, version: "1", main: "index.js", api },
  dir: `/ext/${id}`,
  source,
});
const broken = (dir: string, error: string): ExtensionSource => ({ ok: false, dir, manifest: null, error });

function ctx(id: string, registered: string[]): ExtensionContext {
  return {
    id,
    apiVersion: 1,
    registerAction: (a) => registered.push(`action:${a.id}`),
    registerCommand: (c) => registered.push(`command:${c.id}`),
    registerSettingsTab: (t) => registered.push(`tab:${t.id}`),
    registerMount: (m) => registered.push(`mount:${m.id}`),
    registerKbdHint: (h) => registered.push(`hint:${h.id}`),
    onStartup: () => registered.push("startup"),
    on: (t) => registered.push(`on:${t}`),
    invoke: (async () => undefined) as ExtensionContext["invoke"],
    cluster: { context: "c", namespace: "n", selectedResource: null },
    toast: { success: () => "", error: () => "", warning: () => "", info: () => "" },
    openResource: async () => {},
    openExternal: async () => {},
    storage: { get: () => undefined, set() {} },
    log: { info() {}, warn() {}, error() {} },
  };
}

describe("moduleOf", () => {
  test("accepts a default export or a bare activate", () => {
    const act = () => {};
    expect(moduleOf({ default: { activate: act } })?.activate).toBe(act);
    expect(moduleOf({ activate: act })?.activate).toBe(act);
    expect(moduleOf({ default: 42 })).toBeNull();
    expect(moduleOf(null)).toBeNull();
  });
});

describe("loadExtensions", () => {
  test("activates valid modules, records registrations, isolates failures", async () => {
    const importer = async (source: string) => {
      if (source === "boom") throw new Error("SyntaxError: unexpected token");
      if (source === "throws") return { default: { activate: () => { throw new Error("activate failed"); } } };
      if (source === "noact") return { default: {} };
      return { default: { activate: (c: ExtensionContext) => { c.registerCommand({ id: `${c.id}.hello`, label: "Hello", category: "Ext", action() {} }); c.onStartup(() => {}); } } };
    };
    const statuses = await loadExtensions(
      [src("good"), src("boom", "boom"), src("throws", "throws"), src("noact", "noact"), broken("/ext/broken", "manifest.json is not an object"), src("good")],
      { importer, makeContext: ctx },
    );
    expect(statuses.map((s) => [s.id, s.state])).toEqual([
      ["good", "active"],
      ["boom", "failed"],
      ["throws", "failed"],
      ["noact", "failed"],
      ["broken", "invalid"],
      ["good", "invalid"],
    ]);
    expect(statuses[0].registered).toEqual(["command:good.hello", "startup"]);
    expect(statuses[1].error).toContain("SyntaxError");
    expect(statuses[2].error).toBe("activate failed");
    expect(statuses[3].error).toContain("activate()");
    expect(statuses[5].error).toContain("duplicate");
  });
  test("an extension for another API version is refused before import", async () => {
    let imported = false;
    const statuses = await loadExtensions([src("old", "x", 2)], { importer: async () => { imported = true; return {}; }, makeContext: ctx });
    expect(statuses[0].state).toBe("invalid");
    expect(imported).toBe(false);
  });
});
