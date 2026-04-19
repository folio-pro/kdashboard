import { describe, expect, test } from "bun:test";
import { detectAndFormat } from "./parse-value";

describe("detectAndFormat", () => {
  describe("JSON detection", () => {
    test("valid JSON object → formatted", () => {
      const result = detectAndFormat('{"key":"value","num":42}');
      expect(result.type).toBe("json");
      expect(result.formatted).toBe('{\n  "key": "value",\n  "num": 42\n}');
    });

    test("valid JSON array → formatted", () => {
      const result = detectAndFormat('[1,2,3]');
      expect(result.type).toBe("json");
      expect(result.formatted).toBe("[\n  1,\n  2,\n  3\n]");
    });

    test("invalid JSON starting with { → text fallback", () => {
      const result = detectAndFormat("{not valid json}");
      expect(result.type).toBe("text");
      expect(result.formatted).toBe("{not valid json}");
    });

    test("JSON string value (not object/array) → text", () => {
      const result = detectAndFormat('"just a string"');
      expect(result.type).toBe("text");
      expect(result.formatted).toBe('"just a string"');
    });

    test("JSON with leading whitespace → still detected", () => {
      const result = detectAndFormat('  {"key": "value"}');
      expect(result.type).toBe("json");
    });
  });

  describe("YAML detection", () => {
    test("valid multi-line YAML → formatted", () => {
      const yaml = "apiVersion: v1\nkind: Mapping\nprefix: /api";
      const result = detectAndFormat(yaml);
      expect(result.type).toBe("yaml");
      expect(result.formatted).toContain("apiVersion");
    });

    test("YAML with nested structure → formatted", () => {
      const yaml = "spec:\n  containers:\n    - name: app\n      image: nginx";
      const result = detectAndFormat(yaml);
      expect(result.type).toBe("yaml");
    });

    test("multi-line plain text (not YAML-like) → text", () => {
      // A string that has newlines but doesn't parse into an object
      const result = detectAndFormat("line one\nline two\nline three");
      // This might parse as a string in YAML, which we filter out (not object/array)
      expect(result.type).toBe("text");
    });

    test("invalid YAML with special chars → text fallback", () => {
      const result = detectAndFormat("key: [\ninvalid:\n  - ]malformed");
      // If yaml parser throws, should fall back to text
      expect(result.type).toBe("text");
    });
  });

  describe("text passthrough", () => {
    test("plain text → text type", () => {
      const result = detectAndFormat("just a simple value");
      expect(result.type).toBe("text");
      expect(result.formatted).toBe("just a simple value");
    });

    test("empty string → text type", () => {
      const result = detectAndFormat("");
      expect(result.type).toBe("text");
      expect(result.formatted).toBe("");
    });

    test("single line with colon → text (no newline, not YAML)", () => {
      const result = detectAndFormat("key: value");
      expect(result.type).toBe("text");
      expect(result.formatted).toBe("key: value");
    });

    test("boolean string → text", () => {
      const result = detectAndFormat("true");
      expect(result.type).toBe("text");
      expect(result.formatted).toBe("true");
    });

    test("numeric string → text", () => {
      const result = detectAndFormat("12345");
      expect(result.type).toBe("text");
      expect(result.formatted).toBe("12345");
    });
  });

  describe("edge cases", () => {
    test("large value (10KB+) → parses without crash", () => {
      const largeJson = JSON.stringify({ data: "x".repeat(10000) });
      const result = detectAndFormat(largeJson);
      expect(result.type).toBe("json");
      expect(result.formatted.length).toBeGreaterThan(10000);
    });

    test("YAML with block scalar → formats correctly", () => {
      const yaml = "config: |\n  line1\n  line2\n  line3";
      const result = detectAndFormat(yaml);
      expect(result.type).toBe("yaml");
    });

    test("null-ish input → text fallback", () => {
      const result = detectAndFormat(null as unknown as string);
      expect(result.type).toBe("text");
    });
  });
});
