import { describe, expect, test } from "bun:test";
import { isInputElement, isInputLikeTag } from "./dom";

describe("isInputElement (guard paths, no DOM)", () => {
  test("returns false for null", () => {
    expect(isInputElement(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isInputElement(undefined as any)).toBe(false);
  });

  test("returns false for plain object (not HTMLElement instance)", () => {
    expect(isInputElement({ tagName: "INPUT", isContentEditable: false } as any)).toBe(false);
  });
});

describe("isInputLikeTag (pure logic, no DOM needed)", () => {
  test("INPUT is input-like", () => {
    expect(isInputLikeTag("INPUT", false)).toBe(true);
  });

  test("TEXTAREA is input-like", () => {
    expect(isInputLikeTag("TEXTAREA", false)).toBe(true);
  });

  test("SELECT is input-like", () => {
    expect(isInputLikeTag("SELECT", false)).toBe(true);
  });

  test("contentEditable element is input-like", () => {
    expect(isInputLikeTag("DIV", true)).toBe(true);
  });

  test("DIV without contentEditable is NOT input-like", () => {
    expect(isInputLikeTag("DIV", false)).toBe(false);
  });

  test("SPAN is NOT input-like", () => {
    expect(isInputLikeTag("SPAN", false)).toBe(false);
  });

  test("BUTTON is NOT input-like", () => {
    expect(isInputLikeTag("BUTTON", false)).toBe(false);
  });

  test("A is NOT input-like", () => {
    expect(isInputLikeTag("A", false)).toBe(false);
  });
});
