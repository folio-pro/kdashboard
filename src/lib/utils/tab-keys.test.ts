import { describe, expect, test } from "bun:test";
import { tabSwitchFor } from "./tab-keys";

const key = (init: Partial<KeyboardEvent>) =>
  ({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  }) as KeyboardEvent;

describe("tabSwitchFor", () => {
  test("Ctrl+Tab / Ctrl+Shift+Tab cycle", () => {
    expect(tabSwitchFor(key({ key: "Tab", code: "Tab", ctrlKey: true }))).toBe("next");
    expect(tabSwitchFor(key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }))).toBe("previous");
  });

  test("plain Tab and Cmd+Tab are left alone", () => {
    expect(tabSwitchFor(key({ key: "Tab", code: "Tab" }))).toBeNull();
    expect(tabSwitchFor(key({ key: "Tab", code: "Tab", shiftKey: true }))).toBeNull();
    expect(tabSwitchFor(key({ key: "Tab", code: "Tab", metaKey: true }))).toBeNull();
  });

  test("⌘⇧] / ⌘⇧[ cycle, with Cmd or Ctrl, whatever the shifted character", () => {
    expect(tabSwitchFor(key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }))).toBe("next");
    expect(tabSwitchFor(key({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }))).toBe("previous");
  });

  test("⌘] / ⌘[ without Shift stay with the editor (indent)", () => {
    expect(tabSwitchFor(key({ key: "]", code: "BracketRight", metaKey: true }))).toBeNull();
    expect(tabSwitchFor(key({ key: "[", code: "BracketLeft", metaKey: true }))).toBeNull();
  });

  test("⌘1…⌘8 map to indexes 0…7, ⌘9 to the last tab", () => {
    expect(tabSwitchFor(key({ key: "1", code: "Digit1", metaKey: true }))).toEqual({ index: 0 });
    expect(tabSwitchFor(key({ key: "8", code: "Digit8", ctrlKey: true }))).toEqual({ index: 7 });
    expect(tabSwitchFor(key({ key: "9", code: "Digit9", metaKey: true }))).toEqual({ index: -1 });
  });

  test("digits use the physical key (AZERTY ⌘& is ⌘1)", () => {
    expect(tabSwitchFor(key({ key: "&", code: "Digit1", metaKey: true }))).toEqual({ index: 0 });
  });

  test("bare digits, ⌘0, and Alt/Shift chords are not tab switches", () => {
    expect(tabSwitchFor(key({ key: "1", code: "Digit1" }))).toBeNull();
    expect(tabSwitchFor(key({ key: "0", code: "Digit0", metaKey: true }))).toBeNull();
    expect(tabSwitchFor(key({ key: "1", code: "Digit1", metaKey: true, altKey: true }))).toBeNull();
    expect(tabSwitchFor(key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }))).toBeNull();
  });
});
