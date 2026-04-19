import { describe, expect, mock, test } from "bun:test";
import { confirmDelete, handleBulkDelete, pluralResource } from "./bulk-action-bar.logic";

describe("handleBulkDelete", () => {
  test("opens the confirm dialog when selection is non-empty", () => {
    expect(handleBulkDelete(1)).toEqual({ showConfirm: true });
    expect(handleBulkDelete(42)).toEqual({ showConfirm: true });
  });

  test("stays closed when zero items are selected", () => {
    // Regression: the click handler must short-circuit on empty selection so a
    // rogue call path cannot show a confirm dialog that would then call ondelete
    // against nothing (and silently "succeed").
    expect(handleBulkDelete(0)).toEqual({ showConfirm: false });
  });

  test("stays closed for negative counts (defensive)", () => {
    // selectedCount is a number prop and a bug upstream could underflow it.
    // The guard uses `<= 0` rather than `=== 0` to avoid opening on -1/NaN.
    expect(handleBulkDelete(-1)).toEqual({ showConfirm: false });
    expect(handleBulkDelete(Number.NaN)).toEqual({ showConfirm: false });
  });
});

describe("confirmDelete", () => {
  test("invokes ondelete exactly once and closes the dialog", () => {
    const ondelete = mock(() => {});
    const result = confirmDelete({ ondelete });
    expect(ondelete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ showConfirm: false });
  });

  test("propagates synchronous errors from ondelete", () => {
    const ondelete = mock(() => {
      throw new Error("api unreachable");
    });
    expect(() => confirmDelete({ ondelete })).toThrow("api unreachable");
  });
});

describe("pluralResource", () => {
  test("returns singular for 1", () => {
    expect(pluralResource(1)).toBe("resource");
  });

  test("returns plural for 0, 2, N", () => {
    expect(pluralResource(0)).toBe("resources");
    expect(pluralResource(2)).toBe("resources");
    expect(pluralResource(100)).toBe("resources");
  });
});
