import { describe, expect, test } from "bun:test";
import { overlayOpen } from "./dom";

/** A root that answers querySelector like the DOM would for one selector list. */
function rootWith(matching: boolean): ParentNode {
  return { querySelector: () => (matching ? ({} as Element) : null) } as unknown as ParentNode;
}

describe("overlayOpen", () => {
  test("no root, no overlay", () => {
    expect(overlayOpen(null)).toBe(false);
  });

  test("an open dialog or floating layer claims Escape", () => {
    expect(overlayOpen(rootWith(true))).toBe(true);
    expect(overlayOpen(rootWith(false))).toBe(false);
  });

  // Regression: the selector used to read `[data-bits-floating-content]`, an
  // attribute bits-ui never stamps — it renders the wrapper form. That clause
  // matched nothing, so selects and popovers did not claim the keyboard and
  // the scoped shortcuts behind them kept firing.
  test("covers the attribute bits-ui stamps on floating content", () => {
    let selector = "";
    const root = {
      querySelector: (s: string) => {
        selector = s;
        return null;
      },
    } as unknown as ParentNode;
    overlayOpen(root);
    expect(selector).toContain("[data-bits-floating-content-wrapper]");
  });
});
