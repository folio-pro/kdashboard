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
});
