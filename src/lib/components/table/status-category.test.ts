import { describe, expect, test } from "bun:test";
import { statusCategory, isQuietStatus, rowSeverity } from "./status-category";

describe("status category", () => {
  test("maps known statuses case-insensitively", () => {
    expect(statusCategory("Running")).toBe("success");
    expect(statusCategory("CrashLoopBackOff")).toBe("error");
    expect(statusCategory("Pending")).toBe("warning");
    expect(statusCategory("Succeeded")).toBe("info");
    expect(statusCategory("Terminating")).toBe("orange");
    expect(statusCategory("whatever")).toBe("muted");
  });
  test("healthy and finished rows are quiet; problems are not", () => {
    expect(isQuietStatus("success")).toBe(true);
    expect(isQuietStatus("info")).toBe(true);
    expect(isQuietStatus("muted")).toBe(true);
    expect(isQuietStatus("warning")).toBe(false);
    expect(isQuietStatus("error")).toBe(false);
    expect(isQuietStatus("orange")).toBe(false);
  });
  test("row severity only for problems", () => {
    expect(rowSeverity("error")).toBe("error");
    expect(rowSeverity("warning")).toBe("warning");
    expect(rowSeverity("orange")).toBe("warning");
    expect(rowSeverity("success")).toBeNull();
    expect(rowSeverity("info")).toBeNull();
  });
});
