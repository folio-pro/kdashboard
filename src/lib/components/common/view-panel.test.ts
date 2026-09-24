import { describe, expect, test } from "bun:test";
import { namespaceChangeTracker } from "./view-panel.logic";

describe("namespaceChangeTracker", () => {
  test("the first namespace seen is not a change (openAppView already loaded it)", () => {
    const changed = namespaceChangeTracker();
    expect(changed("default")).toBe(false);
  });

  test("a different namespace after the first is a change", () => {
    const changed = namespaceChangeTracker();
    changed("default");
    expect(changed("shop")).toBe(true);
  });

  test("the same namespace again is not a change", () => {
    const changed = namespaceChangeTracker();
    changed("default");
    expect(changed("default")).toBe(false);
  });

  test("switching to all namespaces (\"\") and back both count", () => {
    const changed = namespaceChangeTracker();
    changed("default");
    expect(changed("")).toBe(true);
    expect(changed("")).toBe(false);
    expect(changed("default")).toBe(true);
  });

  test("each tracker is independent", () => {
    const a = namespaceChangeTracker();
    const b = namespaceChangeTracker();
    a("default");
    expect(b("shop")).toBe(false);
    expect(a("shop")).toBe(true);
  });
});
