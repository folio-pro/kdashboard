import { describe, expect, test, beforeEach } from "bun:test";
import { ToastStoreLogic, getToastDuration } from "./toast.logic";

describe("getToastDuration", () => {
  test("error type defaults to 8000ms", () => {
    expect(getToastDuration("error")).toBe(8000);
  });

  test("success type defaults to 4000ms", () => {
    expect(getToastDuration("success")).toBe(4000);
  });

  test("info type defaults to 4000ms", () => {
    expect(getToastDuration("info")).toBe(4000);
  });

  test("warning type defaults to 4000ms", () => {
    expect(getToastDuration("warning")).toBe(4000);
  });

  test("custom duration overrides default", () => {
    expect(getToastDuration("error", 1000)).toBe(1000);
    expect(getToastDuration("info", 10000)).toBe(10000);
  });

  test("custom duration 0 returns 0", () => {
    expect(getToastDuration("error", 0)).toBe(0);
  });
});

describe("ToastStore", () => {
  let store: ToastStoreLogic;

  beforeEach(() => {
    store = new ToastStoreLogic();
  });

  test("add() creates toast with unique ID", () => {
    const id1 = store.add({ type: "info", title: "First" });
    const id2 = store.add({ type: "info", title: "Second" });
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^toast-\d+$/);
    expect(id2).toMatch(/^toast-\d+$/);
  });

  test("add() stores toast in toasts array", () => {
    store.add({ type: "success", title: "Hello" });
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].title).toBe("Hello");
    expect(store.toasts[0].type).toBe("success");
  });

  test("add() uses 4000ms default duration for non-error types", () => {
    store.add({ type: "info", title: "Test" });
    expect(store.toasts).toHaveLength(1);
  });

  test("add() uses 8000ms default duration for error type", () => {
    store.add({ type: "error", title: "Error" });
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].type).toBe("error");
  });

  test("add() respects custom duration", () => {
    store.add({ type: "info", title: "Custom", duration: 1000 });
    expect(store.toasts).toHaveLength(1);
  });

  test("add() with duration 0 does not auto-dismiss", () => {
    store.add({ type: "info", title: "Persistent", duration: 0 });
    expect(store.toasts).toHaveLength(1);
  });

  test("dismiss() removes a toast by id", () => {
    const id = store.add({ type: "info", title: "To dismiss" });
    expect(store.toasts).toHaveLength(1);
    store.dismiss(id);
    expect(store.toasts).toHaveLength(0);
  });

  test("dismiss() only removes the targeted toast", () => {
    const id1 = store.add({ type: "info", title: "First" });
    const id2 = store.add({ type: "info", title: "Second" });
    expect(store.toasts).toHaveLength(2);
    store.dismiss(id1);
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].id).toBe(id2);
  });

  test("dismiss() is safe to call with non-existent id", () => {
    store.add({ type: "info", title: "Test" });
    store.dismiss("nonexistent");
    expect(store.toasts).toHaveLength(1);
  });

  test("success() creates toast with type success", () => {
    store.success("Done", "All good");
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].type).toBe("success");
    expect(store.toasts[0].title).toBe("Done");
    expect(store.toasts[0].description).toBe("All good");
  });

  test("error() creates toast with type error", () => {
    const onClick = () => {};
    store.error("Failed", "Something broke", { label: "Retry", onClick });
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].type).toBe("error");
    expect(store.toasts[0].title).toBe("Failed");
    expect(store.toasts[0].description).toBe("Something broke");
    expect(store.toasts[0].action?.label).toBe("Retry");
  });

  test("warning() creates toast with type warning", () => {
    store.warning("Careful");
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].type).toBe("warning");
    expect(store.toasts[0].title).toBe("Careful");
    expect(store.toasts[0].description).toBeUndefined();
  });

  test("info() creates toast with type info", () => {
    store.info("FYI", "Just so you know");
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].type).toBe("info");
    expect(store.toasts[0].title).toBe("FYI");
    expect(store.toasts[0].description).toBe("Just so you know");
  });

  test("multiple toasts can coexist", () => {
    store.success("First");
    store.error("Second");
    store.warning("Third");
    store.info("Fourth");
    expect(store.toasts).toHaveLength(4);
    expect(store.toasts.map((t) => t.type)).toEqual([
      "success",
      "error",
      "warning",
      "info",
    ]);
  });
});
