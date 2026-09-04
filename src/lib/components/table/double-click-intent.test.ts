import { describe, expect, test } from "bun:test";
import { DOUBLE_CLICK_WINDOW_MS, DoubleClickIntent } from "./double-click-intent";

describe("DoubleClickIntent", () => {
  test("a plain double-click on one row opens that row", () => {
    const d = new DoubleClickIntent();
    d.click("a", 1000);
    d.click("a", 1150);
    expect(d.resolve("a", 1150)).toBe("a");
  });

  test("when a row slid under the pointer between the clicks, the first row wins", () => {
    const d = new DoubleClickIntent();
    d.click("a", 1000);
    // The watch inserted a row; the second click (which the browser fires
    // before dblclick) lands on the neighbour.
    d.click("b", 1200);
    expect(d.resolve("b", 1200)).toBe("a");
  });

  test("a click outside the window starts a new sequence", () => {
    const d = new DoubleClickIntent();
    d.click("a", 1000);
    d.click("b", 1000 + DOUBLE_CLICK_WINDOW_MS);
    expect(d.resolve("b", 1000 + DOUBLE_CLICK_WINDOW_MS + 100)).toBe("b");
  });

  test("resolving clears the sequence so the next double-click is judged on its own", () => {
    const d = new DoubleClickIntent();
    d.click("a", 1000);
    expect(d.resolve("a", 1100)).toBe("a");
    d.click("b", 1200);
    expect(d.resolve("b", 1300)).toBe("b");
  });

  test("a double-click with no prior click opens the row itself", () => {
    expect(new DoubleClickIntent().resolve("z", 5)).toBe("z");
  });
});
