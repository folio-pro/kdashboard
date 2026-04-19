import { describe, expect, test, beforeEach } from "bun:test";
import { createState, isVisible, computeProgress } from "./update-banner";
import type { UpdateBannerState } from "./update-banner";

describe("UpdateBanner state logic", () => {
  let state: UpdateBannerState;

  beforeEach(() => {
    state = createState();
  });

  test("initial state is not visible", () => {
    expect(isVisible(state)).toBe(false);
  });

  test("becomes visible when updateInfo is set", () => {
    state.updateInfo = { version: "0.2.0", body: "Bug fixes", date: null };
    expect(isVisible(state)).toBe(true);
  });

  test("dismiss hides the banner", () => {
    state.updateInfo = { version: "0.2.0", body: null, date: null };
    expect(isVisible(state)).toBe(true);
    state.dismissed = true;
    expect(isVisible(state)).toBe(false);
  });

  test("dismiss persists even if updateInfo changes", () => {
    state.updateInfo = { version: "0.2.0", body: null, date: null };
    state.dismissed = true;
    state.updateInfo = { version: "0.3.0", body: null, date: null };
    expect(isVisible(state)).toBe(false);
  });

  test("installing flag prevents duplicate installs", () => {
    state.updateInfo = { version: "0.2.0", body: null, date: null };
    state.installing = true;
    expect(state.installing).toBe(true);
  });

  test("updateInfo carries version and body", () => {
    state.updateInfo = {
      version: "1.0.0",
      body: "## What's new\n- Feature A\n- Bug fix B",
      date: "2026-03-16T00:00:00Z",
    };
    expect(state.updateInfo.version).toBe("1.0.0");
    expect(state.updateInfo.body).toContain("Feature A");
    expect(state.updateInfo.date).toBe("2026-03-16T00:00:00Z");
  });

  test("updateInfo with null body and date is valid", () => {
    state.updateInfo = { version: "0.2.0", body: null, date: null };
    expect(isVisible(state)).toBe(true);
    expect(state.updateInfo.body).toBeNull();
    expect(state.updateInfo.date).toBeNull();
  });
});

describe("computeProgress", () => {
  test("computes percentage correctly", () => {
    expect(computeProgress(250, 1000)).toBe(25);
    expect(computeProgress(750, 1000)).toBe(75);
    expect(computeProgress(1000, 1000)).toBe(100);
  });

  test("returns 0 for zero content length", () => {
    expect(computeProgress(100, 0)).toBe(0);
  });

  test("rounds to nearest integer", () => {
    expect(computeProgress(1, 3)).toBe(33);
    expect(computeProgress(2, 3)).toBe(67);
  });
});
