import { test, expect, describe } from "bun:test";

import type { Resource } from "$lib/types";
import { FLASH_MS, LiveValuesLogic, NO_FLASH, signalsFor } from "./live-values.logic";

function hpa(current: number, desired: number, utilization: number | null): Resource {
  return {
    kind: "HorizontalPodAutoscaler",
    api_version: "autoscaling/v2",
    metadata: {
      name: "web",
      namespace: "prod",
      uid: "u1",
      creation_timestamp: "",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {
      metrics: [{ type: "Resource", resource: { name: "cpu", target: { averageUtilization: 80 } } }],
    },
    status: {
      currentReplicas: current,
      desiredReplicas: desired,
      currentMetrics:
        utilization === null
          ? []
          : [{ type: "Resource", resource: { name: "cpu", current: { averageUtilization: utilization } } }],
    },
  };
}

describe("signalsFor", () => {
  test("opts in the three autoscalers and nothing else", () => {
    expect(signalsFor("hpa")).not.toBeNull();
    expect(signalsFor("vpa")).not.toBeNull();
    expect(signalsFor("wpa")).not.toBeNull();
    expect(signalsFor("pods")).toBeNull();
    expect(signalsFor("deployments")).toBeNull();
  });

  test("reads the binding metric's pressure and the desired replicas", () => {
    const read = signalsFor("hpa")!;
    // 40 of a target of 80 is half the pressure that would trigger a scale up.
    expect(read(hpa(3, 5, 40))).toEqual({ autoscalerTargets: 50, autoscalerReplicas: 5 });
  });

  test("reports no pressure while the metric has no reading", () => {
    const read = signalsFor("hpa")!;
    expect(read(hpa(3, 3, null))).toEqual({ autoscalerTargets: null, autoscalerReplicas: 3 });
  });
});

describe("LiveValuesLogic", () => {
  test("records the direction each column moved", () => {
    const live = new LiveValuesLogic();
    const changed = live.compare(
      "u1",
      { autoscalerTargets: 50, autoscalerReplicas: 3 },
      { autoscalerTargets: 90, autoscalerReplicas: 2 },
      1_000,
    );
    expect(changed).toBe(true);
    expect(live.direction("u1", "autoscalerTargets", 1_000)).toBe("up");
    expect(live.direction("u1", "autoscalerReplicas", 1_000)).toBe("down");
  });

  test("ignores a value that did not move", () => {
    const live = new LiveValuesLogic();
    expect(live.compare("u1", { a: 5 }, { a: 5 }, 0)).toBe(false);
    expect(live.direction("u1", "a", 0)).toBeNull();
    expect(live.generation).toBe(0);
  });

  test("does not flash a value appearing for the first time", () => {
    const live = new LiveValuesLogic();
    // The metric had no reading yet; filling in is not a change to chase.
    expect(live.compare("u1", { autoscalerTargets: null }, { autoscalerTargets: 70 }, 0)).toBe(false);
    expect(live.direction("u1", "autoscalerTargets", 0)).toBeNull();
  });

  test("ignores a value that disappears", () => {
    const live = new LiveValuesLogic();
    expect(live.compare("u1", { autoscalerTargets: 70 }, { autoscalerTargets: null }, 0)).toBe(false);
  });

  test("keeps rows independent", () => {
    const live = new LiveValuesLogic();
    live.compare("u1", { a: 1 }, { a: 2 }, 0);
    expect(live.direction("u1", "a", 0)).toBe("up");
    expect(live.direction("u2", "a", 0)).toBeNull();
  });

  test("expires a flash once the window passes", () => {
    const live = new LiveValuesLogic();
    live.compare("u1", { a: 1 }, { a: 2 }, 0);
    expect(live.direction("u1", "a", FLASH_MS - 1)).toBe("up");
    expect(live.direction("u1", "a", FLASH_MS)).toBeNull();
  });

  test("sweeps only what has expired, and bumps the generation once", () => {
    const live = new LiveValuesLogic();
    live.compare("u1", { a: 1 }, { a: 2 }, 0);
    live.compare("u2", { a: 1 }, { a: 2 }, FLASH_MS);
    const before = live.generation;

    expect(live.sweep(FLASH_MS)).toBe(true);
    expect(live.generation).toBe(before + 1);
    expect(live.pending).toBe(true);
    expect(live.direction("u2", "a", FLASH_MS)).toBe("up");

    expect(live.sweep(FLASH_MS * 2)).toBe(true);
    expect(live.pending).toBe(false);
  });

  test("a sweep with nothing to drop changes nothing", () => {
    const live = new LiveValuesLogic();
    live.compare("u1", { a: 1 }, { a: 2 }, 0);
    const before = live.generation;
    expect(live.sweep(0)).toBe(false);
    expect(live.generation).toBe(before);
  });

  test("rowFlash reports both of a row's live values at once", () => {
    const live = new LiveValuesLogic();
    live.compare("u1", { autoscalerTargets: 50, autoscalerReplicas: 3 },
                        { autoscalerTargets: 90, autoscalerReplicas: 2 }, 0);
    expect(live.rowFlash("u1", 0)).toEqual({ targets: "up", replicas: "down" });
    // Expired and unknown rows both read as "nothing moved", so the caller
    // never has to distinguish them.
    expect(live.rowFlash("u1", FLASH_MS)).toEqual(NO_FLASH);
    expect(live.rowFlash("u2", 0)).toEqual(NO_FLASH);
    expect(live.rowFlash(undefined, 0)).toEqual(NO_FLASH);
  });

  test("nextExpiry tracks the oldest pending flash, not the newest", () => {
    const live = new LiveValuesLogic();
    expect(live.nextExpiry()).toBeNull();

    live.compare("u1", { a: 1 }, { a: 2 }, 0);
    live.compare("u2", { a: 1 }, { a: 2 }, 500);
    // The second flash must not push the sweep out to 500 + FLASH_MS, or the
    // first one's arrow stays up for 500ms after it expired.
    expect(live.nextExpiry()).toBe(FLASH_MS);

    live.sweep(FLASH_MS);
    expect(live.nextExpiry()).toBe(500 + FLASH_MS);

    live.sweep(500 + FLASH_MS);
    expect(live.nextExpiry()).toBeNull();
  });

  test("clear drops everything, and is a no-op when already empty", () => {
    const live = new LiveValuesLogic();
    live.compare("u1", { a: 1 }, { a: 2 }, 0);
    live.clear();
    expect(live.pending).toBe(false);
    const after = live.generation;
    live.clear();
    expect(live.generation).toBe(after);
  });
});
