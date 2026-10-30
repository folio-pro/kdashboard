import { describe, expect, test } from "bun:test";
import { scopeOfView } from "./shortcut-scope";

describe("scopeOfView", () => {
  test("resource and CRD tables share the table scope", () => {
    expect(scopeOfView("table")).toBe("table");
    expect(scopeOfView("crd-table")).toBe("table");
  });

  test("details has its own scope", () => {
    expect(scopeOfView("details")).toBe("details");
  });

  test("other views only get global shortcuts", () => {
    expect(scopeOfView("topology")).toBeNull();
    expect(scopeOfView("settings")).toBeNull();
  });
});
