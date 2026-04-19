import { afterEach, describe, expect, test } from "bun:test";
import { formatAge, formatTimestamp } from "./age";

const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
});

describe("formatAge", () => {
  test("returns Unknown for empty timestamp", () => {
    expect(formatAge("")).toBe("Unknown");
  });

  test("returns < 1s for future dates", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    Date.now = () => now;
    expect(formatAge("2026-01-01T00:00:01Z")).toBe("< 1s");
  });

  test("formats days and hours", () => {
    const now = new Date("2026-01-02T02:00:00Z").getTime();
    Date.now = () => now;
    expect(formatAge("2026-01-01T00:00:00Z")).toBe("1d2h");
  });

  test("formats hours and minutes", () => {
    const now = new Date("2026-01-01T03:15:00Z").getTime();
    Date.now = () => now;
    expect(formatAge("2026-01-01T00:00:00Z")).toBe("3h15m");
  });

  test("formats minutes and seconds", () => {
    const now = new Date("2026-01-01T00:02:05Z").getTime();
    Date.now = () => now;
    expect(formatAge("2026-01-01T00:00:00Z")).toBe("2m5s");
  });
});

describe("formatTimestamp", () => {
  test("returns Unknown for empty timestamp", () => {
    expect(formatTimestamp("")).toBe("Unknown");
  });

  test("returns a localized date string for valid timestamps", () => {
    const formatted = formatTimestamp("2026-01-01T00:00:00Z");
    expect(formatted).not.toBe("Unknown");
    expect(formatted.length).toBeGreaterThan(0);
  });

  test("returns Invalid Date for invalid timestamp strings", () => {
    expect(formatTimestamp("not-a-date").toLowerCase()).toContain("invalid");
  });
});
