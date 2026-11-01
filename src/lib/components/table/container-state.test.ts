import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { containerStates } from "./container-state";

const pod = (containerStatuses: unknown[] | undefined) => ({ status: { containerStatuses } }) as unknown as Resource;

describe("containerStates", () => {
  test("no statuses yet means no ticks", () => {
    expect(containerStates(pod(undefined))).toEqual([]);
  });

  test("ready and running is the quiet case", () => {
    expect(containerStates(pod([{ name: "main", ready: true, state: { running: {} } }]))).toEqual([{ name: "main", state: "running" }]);
  });

  test("a crash loop is an error, an image pull in progress only waits", () => {
    const states = containerStates(pod([
      { name: "a", ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } },
      { name: "b", ready: false, state: { waiting: { reason: "ContainerCreating" } } },
    ]));
    expect(states.map((s) => s.state)).toEqual(["error", "waiting"]);
  });

  test("exit 0 finishes, a non-zero exit fails", () => {
    const states = containerStates(pod([
      { name: "a", ready: false, state: { terminated: { exitCode: 0 } } },
      { name: "b", ready: false, state: { terminated: { exitCode: 137 } } },
    ]));
    expect(states.map((s) => s.state)).toEqual(["terminated", "error"]);
  });

  test("running but not ready waits", () => {
    expect(containerStates(pod([{ name: "a", ready: false, state: { running: {} } }]))[0].state).toBe("waiting");
  });
});
