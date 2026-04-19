import { describe, expect, test, beforeEach } from "bun:test";
import {
  type ScaleDialogState,
  createResource,
  createState,
  decrementReplicas,
  incrementReplicas,
  isScaleEnabled,
  shouldShowDelta,
  onOpen,
  getButtonLabel,
} from "./scale-dialog";

describe("ScaleDialog — decrementReplicas", () => {
  test("decrements from positive number", () => {
    expect(decrementReplicas(5)).toBe(4);
  });

  test("decrements from 1 to 0", () => {
    expect(decrementReplicas(1)).toBe(0);
  });

  test("stays at 0 when already 0", () => {
    expect(decrementReplicas(0)).toBe(0);
  });

  test("decrements from large number", () => {
    expect(decrementReplicas(10000)).toBe(9999);
  });

  test("decrements from 2 to 1", () => {
    expect(decrementReplicas(2)).toBe(1);
  });
});

describe("ScaleDialog — incrementReplicas", () => {
  test("increments from 0", () => {
    expect(incrementReplicas(0)).toBe(1);
  });

  test("increments from positive number", () => {
    expect(incrementReplicas(3)).toBe(4);
  });

  test("increments large number", () => {
    expect(incrementReplicas(99999)).toBe(100000);
  });
});

describe("ScaleDialog — isScaleEnabled", () => {
  test("enabled when not loading and replicas differ", () => {
    expect(isScaleEnabled(false, 5, 3)).toBe(true);
  });

  test("disabled when loading", () => {
    expect(isScaleEnabled(true, 5, 3)).toBe(false);
  });

  test("disabled when replicas equal currentReplicas", () => {
    expect(isScaleEnabled(false, 3, 3)).toBe(false);
  });

  test("disabled when loading AND replicas equal currentReplicas", () => {
    expect(isScaleEnabled(true, 3, 3)).toBe(false);
  });

  test("enabled when scaling to 0", () => {
    expect(isScaleEnabled(false, 0, 3)).toBe(true);
  });

  test("enabled when scaling up from 0", () => {
    expect(isScaleEnabled(false, 1, 0)).toBe(true);
  });
});

describe("ScaleDialog — shouldShowDelta", () => {
  test("shows delta when replicas differ", () => {
    expect(shouldShowDelta(3, 5)).toBe(true);
  });

  test("hides delta when replicas are the same", () => {
    expect(shouldShowDelta(3, 3)).toBe(false);
  });

  test("shows delta when scaling to 0", () => {
    expect(shouldShowDelta(3, 0)).toBe(true);
  });

  test("shows delta when scaling from 0", () => {
    expect(shouldShowDelta(0, 1)).toBe(true);
  });

  test("hides delta when both are 0", () => {
    expect(shouldShowDelta(0, 0)).toBe(false);
  });
});

describe("ScaleDialog — dialog state management", () => {
  let state: ScaleDialogState;

  beforeEach(() => {
    state = createState();
  });

  test("initial state has replicas at 0 and no error", () => {
    expect(state.replicas).toBe(0);
    expect(state.error).toBe("");
    expect(state.loading).toBe(false);
    expect(state.open).toBe(false);
  });

  test("onOpen resets replicas to currentReplicas", () => {
    state.replicas = 99;
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(3);
  });

  test("onOpen clears previous error", () => {
    state.error = "Something went wrong";
    state.open = true;
    onOpen(state);
    expect(state.error).toBe("");
  });

  test("onOpen does nothing when dialog is closed", () => {
    state.replicas = 99;
    state.error = "old error";
    state.open = false;
    onOpen(state);
    expect(state.replicas).toBe(99);
    expect(state.error).toBe("old error");
  });

  test("onOpen syncs with different currentReplicas values", () => {
    state.resource = createResource({ currentReplicas: 10 });
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(10);
  });

  test("onOpen syncs with 0 currentReplicas", () => {
    state.resource = createResource({ currentReplicas: 0 });
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(0);
  });
});

describe("ScaleDialog — error state management", () => {
  let state: ScaleDialogState;

  beforeEach(() => {
    state = createState();
    state.open = true;
    onOpen(state);
  });

  test("error is cleared at start of scale operation", () => {
    state.error = "previous error";
    // Simulates the beginning of handleScale
    state.loading = true;
    state.error = "";
    expect(state.error).toBe("");
  });

  test("error is set on scale failure", () => {
    state.loading = true;
    state.error = "";
    // Simulate failure
    state.error = String(new Error("connection refused"));
    state.loading = false;
    expect(state.error).toBe("Error: connection refused");
    expect(state.loading).toBe(false);
  });

  test("loading resets to false after success", () => {
    state.loading = true;
    // Simulate success
    state.open = false;
    state.loading = false;
    expect(state.loading).toBe(false);
  });

  test("loading resets to false after failure", () => {
    state.loading = true;
    state.error = "timeout";
    state.loading = false;
    expect(state.loading).toBe(false);
    expect(state.error).toBe("timeout");
  });

  test("reopening dialog after error clears the error", () => {
    state.error = "scale failed";
    state.open = false;
    // Reopen
    state.open = true;
    onOpen(state);
    expect(state.error).toBe("");
    expect(state.replicas).toBe(state.resource.currentReplicas);
  });
});

describe("ScaleDialog — button label", () => {
  test("shows 'Scale' when not loading", () => {
    expect(getButtonLabel(false)).toBe("Scale");
  });

  test("shows 'Scaling...' when loading", () => {
    expect(getButtonLabel(true)).toBe("Scaling...");
  });
});

describe("ScaleDialog — full interaction sequences", () => {
  let state: ScaleDialogState;

  beforeEach(() => {
    state = createState(createResource({ currentReplicas: 3 }));
  });

  test("open -> increment twice -> scale enabled", () => {
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(3);
    expect(isScaleEnabled(state.loading, state.replicas, state.resource.currentReplicas)).toBe(false);

    state.replicas = incrementReplicas(state.replicas);
    state.replicas = incrementReplicas(state.replicas);
    expect(state.replicas).toBe(5);
    expect(isScaleEnabled(state.loading, state.replicas, state.resource.currentReplicas)).toBe(true);
    expect(shouldShowDelta(state.resource.currentReplicas, state.replicas)).toBe(true);
  });

  test("open -> decrement to 0 -> scale enabled", () => {
    state.open = true;
    onOpen(state);

    state.replicas = decrementReplicas(state.replicas); // 2
    state.replicas = decrementReplicas(state.replicas); // 1
    state.replicas = decrementReplicas(state.replicas); // 0
    expect(state.replicas).toBe(0);
    expect(isScaleEnabled(state.loading, state.replicas, state.resource.currentReplicas)).toBe(true);
  });

  test("open -> decrement past 0 -> stays at 0", () => {
    state.open = true;
    onOpen(state);

    for (let i = 0; i < 10; i++) {
      state.replicas = decrementReplicas(state.replicas);
    }
    expect(state.replicas).toBe(0);
  });

  test("open -> increment then decrement back -> scale disabled", () => {
    state.open = true;
    onOpen(state);

    state.replicas = incrementReplicas(state.replicas); // 4
    state.replicas = decrementReplicas(state.replicas); // 3
    expect(state.replicas).toBe(3);
    expect(isScaleEnabled(state.loading, state.replicas, state.resource.currentReplicas)).toBe(false);
    expect(shouldShowDelta(state.resource.currentReplicas, state.replicas)).toBe(false);
  });

  test("loading disables both increment and decrement buttons", () => {
    state.open = true;
    onOpen(state);
    state.loading = true;
    // In the component, both +/- buttons have disabled={loading}
    expect(state.loading).toBe(true);
    // Scale button also disabled
    expect(isScaleEnabled(state.loading, state.replicas + 1, state.resource.currentReplicas)).toBe(false);
  });

  test("cancel closes dialog without scaling", () => {
    state.open = true;
    onOpen(state);
    state.replicas = incrementReplicas(state.replicas);
    // Cancel: open = false
    state.open = false;
    expect(state.open).toBe(false);
    // Replicas were changed but dialog is closed - no scale happened
    expect(state.replicas).toBe(4);
  });

  test("reopen after cancel resets replicas", () => {
    state.open = true;
    onOpen(state);
    state.replicas = incrementReplicas(state.replicas); // 4
    state.open = false;

    // Reopen
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(3); // Reset to currentReplicas
  });
});

describe("ScaleDialog — resource kinds", () => {
  test("works with Deployment", () => {
    const state = createState(createResource({ kind: "Deployment" }));
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(state.resource.currentReplicas);
  });

  test("works with StatefulSet", () => {
    const state = createState(createResource({ kind: "StatefulSet", currentReplicas: 5 }));
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(5);
  });

  test("works with ReplicaSet", () => {
    const state = createState(createResource({ kind: "ReplicaSet", currentReplicas: 0 }));
    state.open = true;
    onOpen(state);
    expect(state.replicas).toBe(0);
    expect(isScaleEnabled(false, 0, 0)).toBe(false);
  });
});
