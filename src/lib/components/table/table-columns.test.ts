import { describe, expect, test } from "bun:test";
import { columnsByType, migrateHiddenPrefs, minimumTableWidth } from "./table-columns";

describe("migrateHiddenPrefs", () => {
  test("drops v1 entries for columns that are hidden by default, keeps the rest", () => {
    // A v1 user who hid Up-to-date (then shown by default) and Age: Up-to-date
    // is now defaultHidden, so its entry would flip it visible — drop it.
    expect(migrateHiddenPrefs({ deployments: ["upToDate", "age"], pods: ["node"] })).toEqual({
      deployments: ["age"],
      pods: ["node"],
    });
  });

  test("unknown types fall back to the default columns; empty lists vanish", () => {
    expect(migrateHiddenPrefs({ widgets: ["age"], services: ["selector"] })).toEqual({ widgets: ["age"] });
  });
});

describe("columns", () => {
  test("every default-hidden column still exists for the picker", () => {
    const hidden = Object.values(columnsByType).flat().filter((c) => c.defaultHidden).map((c) => c.key);
    expect(hidden).toEqual(expect.arrayContaining(["ip", "upToDate", "available", "selector"]));
  });

  test("the pods table fits a 1280px window once the namespace column is auto-hidden", () => {
    const visible = columnsByType.pods.filter((c) => !c.defaultHidden && c.key !== "namespace");
    expect(minimumTableWidth(visible)).toBeLessThanOrEqual(1280);
  });
});
