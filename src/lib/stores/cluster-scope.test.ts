import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClusterScopeRegistry } from "./cluster-scope.logic";

describe("ClusterScopeRegistry", () => {
  test("resetAll resets every registered store", () => {
    const registry = new ClusterScopeRegistry();
    const calls: string[] = [];
    registry.register("helm", () => calls.push("helm"));
    registry.register("rbac", () => calls.push("rbac"));
    registry.register("rightsizing", () => calls.push("rightsizing"));

    registry.resetAll();

    expect(calls.sort()).toEqual(["helm", "rbac", "rightsizing"]);
  });

  test("a store that throws does not stop the others from resetting", () => {
    const registry = new ClusterScopeRegistry();
    const calls: string[] = [];
    registry.register("broken", () => {
      throw new Error("boom");
    });
    registry.register("netpol", () => calls.push("netpol"));

    const errors: unknown[] = [];
    registry.resetAll((name, err) => errors.push([name, (err as Error).message]));

    expect(calls).toEqual(["netpol"]);
    expect(errors).toEqual([["broken", "boom"]]);
  });

  test("registering the same name again replaces the reset (module re-evaluation under HMR)", () => {
    const registry = new ClusterScopeRegistry();
    const calls: string[] = [];
    registry.register("cost", () => calls.push("old"));
    registry.register("cost", () => calls.push("new"));

    registry.resetAll();

    expect(calls).toEqual(["new"]);
    expect(registry.names).toEqual(["cost"]);
  });

  test("the returned function unregisters", () => {
    const registry = new ClusterScopeRegistry();
    const calls: string[] = [];
    const off = registry.register("topology", () => calls.push("topology"));
    off();

    registry.resetAll();

    expect(calls).toEqual([]);
    expect(registry.names).toEqual([]);
  });
});

// The .svelte.ts singletons can't be imported under bun test (no rune
// compiler), so pin the registration at the source: every store that holds
// one cluster's data must register a reset, or a context switch leaves it
// on screen (and Rightsizing's Apply would patch the new cluster with the
// old cluster's recommendations).
describe("cluster-scoped stores register a context-change reset", () => {
  const STORES = ["helm", "cost", "security", "topology", "overview", "rbac", "netpol", "rightsizing"];
  for (const name of STORES) {
    test(`${name}.svelte.ts`, () => {
      const source = readFileSync(join(import.meta.dir, `${name}.svelte.ts`), "utf8");
      expect(source).toMatch(new RegExp(`onContextChange\\("${name}",\\s*\\(\\) => \\w+Store\\.reset\\(\\)\\)`));
    });
  }
});
