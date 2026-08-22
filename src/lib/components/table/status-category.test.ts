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
  test("derived pod and workload statuses", () => {
    expect(statusCategory("Init:1/2")).toBe("warning");
    expect(statusCategory("Init:CrashLoopBackOff")).toBe("error");
    expect(statusCategory("Init:Error")).toBe("error");
    expect(statusCategory("ExitCode:137")).toBe("error");
    expect(statusCategory("Signal:9")).toBe("error");
    expect(statusCategory("NotReady")).toBe("warning");
    expect(statusCategory("CreateContainerConfigError")).toBe("error");
    expect(statusCategory("Progressing")).toBe("warning");
    expect(statusCategory("Paused")).toBe("warning");
    expect(statusCategory("Unavailable")).toBe("error");
    expect(statusCategory("Scaled to 0")).toBe("muted");
    expect(statusCategory("SomethingBackOff")).toBe("error");
    expect(statusCategory("ContainerCreating")).toBe("warning");
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
