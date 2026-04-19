import { describe, expect, test } from "bun:test";
import { CONTEXT_COLORS, getContextColor, hashString } from "./context-colors";

describe("hashString", () => {
  test("returns a non-negative number", () => {
    expect(hashString("test")).toBeGreaterThanOrEqual(0);
    expect(hashString("production")).toBeGreaterThanOrEqual(0);
    expect(hashString("")).toBeGreaterThanOrEqual(0);
  });

  test("returns consistent results for same input", () => {
    const result1 = hashString("my-cluster");
    const result2 = hashString("my-cluster");
    expect(result1).toBe(result2);
  });

  test("returns different values for different inputs", () => {
    const a = hashString("cluster-a");
    const b = hashString("cluster-b");
    expect(a).not.toBe(b);
  });

  test("produces known output for known input (algorithm stability)", () => {
    // Pin hash values to detect algorithm changes that would shift all context colors
    expect(hashString("test")).toBe(3556498);
    expect(hashString("production")).toBe(1753018553);
    expect(hashString("minikube")).toBe(1359116284);
  });
});

describe("getContextColor", () => {
  test("returns a valid CONTEXT_COLORS entry", () => {
    const color = getContextColor("my-context");
    expect(CONTEXT_COLORS).toContain(color);
  });

  test("is deterministic (same name = same color)", () => {
    const color1 = getContextColor("prod-cluster");
    const color2 = getContextColor("prod-cluster");
    expect(color1).toBe(color2);
  });

  test("works with empty string", () => {
    const color = getContextColor("");
    expect(CONTEXT_COLORS).toContain(color);
  });
});
