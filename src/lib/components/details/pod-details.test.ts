import { describe, expect, test } from "bun:test";
import { podProblemCopy } from "./pod-details.logic";

describe("podProblemCopy", () => {
  test("a crash-looping container names the container, the last exit and the restarts", () => {
    const copy = podProblemCopy({
      container: "api", init: false, reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container",
      exitCode: 1, lastReason: "Error", lastFinishedAt: new Date(Date.now() - 3 * 60_000).toISOString(), restartCount: 7,
    });
    expect(copy.tone).toBe("error");
    expect(copy.title).toBe("Container api is crash-looping");
    expect(copy.lines[0]).toMatch(/^Last exit: code 1 · Error · 3m ago$/);
    expect(copy.lines[1]).toBe("7 restarts");
    expect(copy.lines[2]).toBe("back-off 5m0s restarting failed container");
  });

  test("image pull, init container, and generic reasons", () => {
    expect(podProblemCopy({ container: "web", reason: "ImagePullBackOff", restartCount: 0 }).title).toBe("Container web cannot pull its image");
    expect(podProblemCopy({ container: "migrate", init: true, reason: "Error", exitCode: 2, restartCount: 1 })).toMatchObject({
      title: "Init container migrate failed: Error",
      lines: ["Last exit: code 2", "1 restart"],
    });
    expect(podProblemCopy({ container: "app", reason: "OOMKilled", exitCode: 137, restartCount: 3 }).title).toBe("Container app was OOM-killed");
  });

  test("an unschedulable pod is a warning with the scheduler's message", () => {
    expect(podProblemCopy({ reason: "Unschedulable", message: "0/3 nodes are available: 3 Insufficient cpu.", restartCount: 0 })).toEqual({
      tone: "warning",
      title: "Pod cannot be scheduled",
      lines: ["0/3 nodes are available: 3 Insufficient cpu."],
    });
    expect(podProblemCopy({ reason: "Unschedulable", restartCount: 0 }).lines).toEqual(["Reason: Unschedulable"]);
  });
});
