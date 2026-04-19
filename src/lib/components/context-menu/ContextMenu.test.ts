import { describe, expect, test } from "bun:test";
import {
  calculateMenuPosition,
  estimateMenuHeight,
  isActionEnabled,
  findNextEnabled,
  tierColor,
} from "./context-menu";

// --- Types mirroring the component's usage ---

interface ActionDef {
  id: string;
  label: string;
  tier: string;
  group: string;
  enabled?: (resource: any) => boolean;
  disabledReason?: (resource: any) => string;
  execute: (resource: any) => void;
}

// --- Helpers for building test actions ---

function makeAction(overrides: Partial<ActionDef> = {}): ActionDef {
  return {
    id: overrides.id ?? "test",
    label: overrides.label ?? "Test Action",
    tier: overrides.tier ?? "green",
    group: overrides.group ?? "default",
    execute: overrides.execute ?? (() => {}),
    enabled: overrides.enabled,
    disabledReason: overrides.disabledReason,
  };
}

const dummyResource = { metadata: { name: "nginx", namespace: "default" }, kind: "Pod" };

// =============================================================================
// Tests
// =============================================================================

describe("estimateMenuHeight", () => {
  test("single item, no groups", () => {
    expect(estimateMenuHeight(1, 0)).toBe(1 * 34 + 0 * 8 + 48);
  });

  test("multiple items with groups", () => {
    // 5 items, 2 groups
    expect(estimateMenuHeight(5, 2)).toBe(5 * 34 + 2 * 8 + 48);
  });

  test("zero items still has base padding", () => {
    expect(estimateMenuHeight(0, 0)).toBe(48);
  });

  test("many items produces large height", () => {
    expect(estimateMenuHeight(20, 4)).toBe(20 * 34 + 4 * 8 + 48);
  });
});

describe("calculateMenuPosition", () => {
  const vw = 1280;
  const vh = 720;

  test("menu fits entirely — no adjustment", () => {
    const pos = calculateMenuPosition(100, 100, 3, 1, vw, vh, false);
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(100);
  });

  test("overflows right edge — clamps x", () => {
    // x = 1200, menuW = 220, vw = 1280 → 1200+220 = 1420 > 1272
    const pos = calculateMenuPosition(1200, 100, 3, 1, vw, vh, false);
    expect(pos.x).toBe(vw - 220 - 8); // 1052
    expect(pos.y).toBe(100);
  });

  test("overflows bottom edge — clamps y", () => {
    const menuH = estimateMenuHeight(10, 3);
    // Place y so that y + menuH > vh - 8
    const pos = calculateMenuPosition(100, 600, 10, 3, vw, vh, false);
    expect(pos.y).toBe(vh - menuH - 8);
    expect(pos.x).toBe(100);
  });

  test("overflows both right and bottom — clamps both", () => {
    const pos = calculateMenuPosition(1200, 650, 10, 3, vw, vh, false);
    const menuH = estimateMenuHeight(10, 3);
    expect(pos.x).toBe(vw - 220 - 8);
    expect(pos.y).toBe(vh - menuH - 8);
  });

  test("negative x after right clamp on tiny viewport — floors to 8", () => {
    // Viewport so small that vw - 220 - 8 < 8
    const pos = calculateMenuPosition(10, 10, 1, 0, 230, 800, false);
    // vw - 220 - 8 = 2, then clamped to 8
    expect(pos.x).toBe(8);
  });

  test("negative y after bottom clamp — floors to 8", () => {
    // menuH with 10 items, 3 groups = 10*34+3*8+48 = 412; vh=400 → 400-412-8 = -20 → clamped to 8
    const pos = calculateMenuPosition(100, 300, 10, 3, 1280, 400, false);
    expect(pos.y).toBe(8);
  });

  test("position at exact edge boundary — still adjusts (strict >)", () => {
    // x + menuW = vw - 8 exactly → no adjustment (not >)
    // x = vw - 8 - 220 = 1052 for vw=1280
    const pos = calculateMenuPosition(1052, 100, 1, 0, vw, vh, false);
    expect(pos.x).toBe(1052); // exactly at boundary, no overflow
  });

  test("bulk mode uses same positioning logic", () => {
    const pos = calculateMenuPosition(1200, 100, 3, 1, vw, vh, true);
    expect(pos.x).toBe(vw - 220 - 8);
  });
});

describe("isActionEnabled", () => {
  test("no enabled function — returns true", () => {
    const action = makeAction();
    expect(isActionEnabled(action, dummyResource)).toBe(true);
  });

  test("enabled function returns true", () => {
    const action = makeAction({ enabled: () => true });
    expect(isActionEnabled(action, dummyResource)).toBe(true);
  });

  test("enabled function returns false", () => {
    const action = makeAction({ enabled: () => false });
    expect(isActionEnabled(action, dummyResource)).toBe(false);
  });

  test("enabled function checks resource kind", () => {
    const action = makeAction({
      enabled: (r: any) => r.kind === "Pod",
    });
    expect(isActionEnabled(action, { kind: "Pod" })).toBe(true);
    expect(isActionEnabled(action, { kind: "Service" })).toBe(false);
  });

  test("null resource with enabled function — returns true", () => {
    const action = makeAction({ enabled: () => false });
    expect(isActionEnabled(action, null)).toBe(true);
  });

  test("null resource without enabled function — returns true", () => {
    const action = makeAction();
    expect(isActionEnabled(action, null)).toBe(true);
  });
});

describe("findNextEnabled", () => {
  const enabledAction = makeAction({ id: "a" });
  const disabledAction = makeAction({ id: "b", enabled: () => false });

  test("ArrowDown from -1 finds first enabled item", () => {
    const items = [enabledAction, enabledAction];
    const idx = findNextEnabled(-1, 1, items, false, dummyResource);
    expect(idx).toBe(0);
  });

  test("ArrowDown skips disabled items", () => {
    const items = [disabledAction, disabledAction, enabledAction];
    const idx = findNextEnabled(-1, 1, items, false, dummyResource);
    expect(idx).toBe(2);
  });

  test("ArrowDown at last item — stays in place", () => {
    const items = [enabledAction, enabledAction];
    const idx = findNextEnabled(1, 1, items, false, dummyResource);
    expect(idx).toBe(1);
  });

  test("ArrowUp from 0 — stays in place", () => {
    const items = [enabledAction, enabledAction];
    const idx = findNextEnabled(0, -1, items, false, dummyResource);
    expect(idx).toBe(0);
  });

  test("ArrowUp skips disabled items", () => {
    const items = [enabledAction, disabledAction, disabledAction, enabledAction];
    const idx = findNextEnabled(3, -1, items, false, dummyResource);
    expect(idx).toBe(0);
  });

  test("all actions disabled — stays at current position", () => {
    const items = [disabledAction, disabledAction, disabledAction];
    const idx = findNextEnabled(1, 1, items, false, dummyResource);
    expect(idx).toBe(1);
  });

  test("all actions disabled ArrowUp — stays at current position", () => {
    const items = [disabledAction, disabledAction, disabledAction];
    const idx = findNextEnabled(1, -1, items, false, dummyResource);
    expect(idx).toBe(1);
  });

  test("bulk mode ArrowDown — never skips (all enabled)", () => {
    const items = [disabledAction, disabledAction, disabledAction];
    const idx = findNextEnabled(0, 1, items, true, dummyResource);
    expect(idx).toBe(1); // ignores enabled function
  });

  test("bulk mode ArrowUp — never skips", () => {
    const items = [disabledAction, disabledAction, disabledAction];
    const idx = findNextEnabled(2, -1, items, true, dummyResource);
    expect(idx).toBe(1);
  });

  test("bulk mode at first item ArrowUp — stays", () => {
    const items = [enabledAction, enabledAction];
    const idx = findNextEnabled(0, -1, items, true, dummyResource);
    expect(idx).toBe(0);
  });

  test("bulk mode at last item ArrowDown — stays", () => {
    const items = [enabledAction, enabledAction, enabledAction];
    const idx = findNextEnabled(2, 1, items, true, dummyResource);
    expect(idx).toBe(2);
  });

  test("empty items list — stays at from", () => {
    const idx = findNextEnabled(-1, 1, [], false, dummyResource);
    expect(idx).toBe(-1);
  });

  test("single enabled item — ArrowDown from -1 finds it", () => {
    const items = [enabledAction];
    const idx = findNextEnabled(-1, 1, items, false, dummyResource);
    expect(idx).toBe(0);
  });

  test("enabled sandwiched between disabled — found in both directions", () => {
    const items = [disabledAction, enabledAction, disabledAction];
    expect(findNextEnabled(-1, 1, items, false, dummyResource)).toBe(1);
    expect(findNextEnabled(2, -1, items, false, dummyResource)).toBe(1);
  });
});

describe("tierColor", () => {
  test("red tier maps to --status-failed", () => {
    expect(tierColor("red")).toBe("var(--status-failed)");
  });

  test("yellow tier maps to --status-warning", () => {
    expect(tierColor("yellow")).toBe("var(--status-warning)");
  });

  test("green tier maps to default --text-secondary", () => {
    expect(tierColor("green")).toBe("var(--text-secondary)");
  });

  test("unknown tier maps to default --text-secondary", () => {
    expect(tierColor("purple")).toBe("var(--text-secondary)");
  });

  test("empty string maps to default", () => {
    expect(tierColor("")).toBe("var(--text-secondary)");
  });
});
