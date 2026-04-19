import { describe, expect, test } from "bun:test";
import {
  _getYamlContext as getYamlContext,
  _buildPath as buildPath,
  _clamp as clamp,
  _escapeRegex as escapeRegex,
  _findLinePos as findLinePos,
  _findFieldPos as findFieldPos,
} from "./yaml-intellisense";

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------
describe("clamp", () => {
  test("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test("clamps to min when below range", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  test("clamps to max when above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  test("returns boundary when value equals min", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  test("returns boundary when value equals max", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  test("handles negative ranges", () => {
    expect(clamp(0, -10, -5)).toBe(-5);
  });

  test("handles single-point range", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------
describe("escapeRegex", () => {
  test("escapes dot", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
  });

  test("escapes asterisk and plus", () => {
    expect(escapeRegex("a*b+c")).toBe("a\\*b\\+c");
  });

  test("escapes brackets and parens", () => {
    expect(escapeRegex("[a](b)")).toBe("\\[a\\]\\(b\\)");
  });

  test("escapes caret and dollar", () => {
    expect(escapeRegex("^start$end")).toBe("\\^start\\$end");
  });

  test("escapes braces and pipe", () => {
    expect(escapeRegex("{a|b}")).toBe("\\{a\\|b\\}");
  });

  test("escapes question mark", () => {
    expect(escapeRegex("a?b")).toBe("a\\?b");
  });

  test("escapes backslash", () => {
    expect(escapeRegex("a\\b")).toBe("a\\\\b");
  });

  test("leaves plain strings unchanged", () => {
    expect(escapeRegex("apiVersion")).toBe("apiVersion");
  });

  test("handles empty string", () => {
    expect(escapeRegex("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findLinePos
// ---------------------------------------------------------------------------
describe("findLinePos", () => {
  const doc = `apiVersion: v1
kind: Pod
metadata:
  name: my-pod`;

  test("finds a root-level key", () => {
    const pos = findLinePos(doc, "apiVersion");
    expect(pos).not.toBeNull();
    expect(pos!.from).toBe(0);
    expect(doc.substring(pos!.from, pos!.to)).toBe("apiVersion: v1");
  });

  test("finds kind line", () => {
    const pos = findLinePos(doc, "kind");
    expect(pos).not.toBeNull();
    expect(doc.substring(pos!.from, pos!.to)).toBe("kind: Pod");
  });

  test("returns null for missing key", () => {
    expect(findLinePos(doc, "nonexistent")).toBeNull();
  });

  test("only matches at start of line (not indented)", () => {
    // "name" is indented so findLinePos (which matches ^key:) should not find it
    expect(findLinePos(doc, "name")).toBeNull();
  });

  test("handles doc without trailing newline", () => {
    const shortDoc = "kind: Service";
    const pos = findLinePos(shortDoc, "kind");
    expect(pos).not.toBeNull();
    expect(pos!.to).toBe(shortDoc.length);
  });
});

// ---------------------------------------------------------------------------
// findFieldPos
// ---------------------------------------------------------------------------
describe("findFieldPos", () => {
  const doc = `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
    - name: nginx
      image: nginx:latest`;

  test("finds a root-level field", () => {
    const pos = findFieldPos(doc, "apiVersion");
    expect(pos).not.toBeNull();
    expect(doc.substring(pos!.from, pos!.to)).toBe("apiVersion: v1");
  });

  test("finds an indented field", () => {
    const pos = findFieldPos(doc, "name");
    expect(pos).not.toBeNull();
    // Should find the first occurrence (metadata.name)
    expect(doc.substring(pos!.from, pos!.to).trim()).toBe("name: my-pod");
  });

  test("finds a field prefixed with dash (array item)", () => {
    const pos = findFieldPos(doc, "image");
    expect(pos).not.toBeNull();
    expect(doc.substring(pos!.from, pos!.to).trim()).toBe("image: nginx:latest");
  });

  test("returns null for missing field", () => {
    expect(findFieldPos(doc, "nonexistent")).toBeNull();
  });

  test("handles doc ending without newline", () => {
    const shortDoc = "  foo: bar";
    const pos = findFieldPos(shortDoc, "foo");
    expect(pos).not.toBeNull();
    expect(pos!.to).toBe(shortDoc.length);
  });
});

// ---------------------------------------------------------------------------
// buildPath
// ---------------------------------------------------------------------------
describe("buildPath", () => {
  test("returns empty path at root level", () => {
    const lines = ["kind: Pod", "apiVersion: v1"];
    expect(buildPath(lines, 1, 0)).toEqual([]);
  });

  test("returns parent key for nested field", () => {
    const lines = ["metadata:", "  name: my-pod"];
    expect(buildPath(lines, 1, 2)).toEqual(["metadata"]);
  });

  test("returns multi-level path", () => {
    const lines = ["spec:", "  template:", "    metadata:", "      labels:"];
    expect(buildPath(lines, 3, 6)).toEqual(["spec", "template", "metadata"]);
  });

  test("skips comments and empty lines", () => {
    const lines = ["metadata:", "", "  # comment", "  name: test"];
    expect(buildPath(lines, 3, 2)).toEqual(["metadata"]);
  });

  test("handles array items by skipping to parent", () => {
    const lines = ["spec:", "  containers:", "    - name: nginx", "      image: nginx"];
    // At "image: nginx" (indent=6), the "- name:" line is an array item and should be skipped
    expect(buildPath(lines, 3, 6)).toEqual(["spec", "containers"]);
  });

  test("returns empty path when at first line", () => {
    const lines = ["apiVersion: v1"];
    expect(buildPath(lines, 0, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getYamlContext
// ---------------------------------------------------------------------------
describe("getYamlContext", () => {
  test("detects kind from document", () => {
    const doc = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test";
    const ctx = getYamlContext(doc, doc.length);
    expect(ctx.kind).toBe("Pod");
  });

  test("returns null kind when no kind field", () => {
    const doc = "apiVersion: v1\nmetadata:\n  name: test";
    const ctx = getYamlContext(doc, 0);
    expect(ctx.kind).toBeNull();
  });

  test("isKey is true when cursor is before colon", () => {
    const doc = "apiVersion: v1\nnam";
    const ctx = getYamlContext(doc, doc.length); // cursor at end of "nam"
    expect(ctx.isKey).toBe(true);
  });

  test("isKey is false when cursor is after colon", () => {
    const doc = "apiVersion: v1";
    const ctx = getYamlContext(doc, doc.length); // cursor at end of line (after ":")
    expect(ctx.isKey).toBe(false);
  });

  test("calculates indent correctly", () => {
    const doc = "metadata:\n  name: test";
    // Position at "  name: test" (after the newline)
    const pos = "metadata:\n  ".length;
    const ctx = getYamlContext(doc, pos);
    expect(ctx.indent).toBe(2);
  });

  test("extracts currentLineKey for value position", () => {
    const doc = "apiVersion: ";
    const ctx = getYamlContext(doc, doc.length);
    expect(ctx.isKey).toBe(false);
    expect(ctx.currentLineKey).toBe("apiVersion");
  });

  test("currentLineKey is null for key position", () => {
    const doc = "apiVer";
    const ctx = getYamlContext(doc, doc.length);
    expect(ctx.isKey).toBe(true);
    expect(ctx.currentLineKey).toBeNull();
  });

  test("builds path from indentation hierarchy", () => {
    const doc = "spec:\n  template:\n    metadata:\n      labels:\n        app: ";
    const ctx = getYamlContext(doc, doc.length);
    expect(ctx.path).toEqual(["spec", "template", "metadata", "labels"]);
  });

  test("handles cursor in middle of document", () => {
    const doc = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test\nspec:\n  containers:";
    // cursor at "kind: Pod" value position
    const pos = "apiVersion: v1\nkind: ".length;
    const ctx = getYamlContext(doc, pos);
    expect(ctx.kind).toBe("Pod");
    expect(ctx.isKey).toBe(false);
    expect(ctx.indent).toBe(0);
    expect(ctx.currentLineKey).toBe("kind");
  });

  test("handles empty document", () => {
    const doc = "";
    const ctx = getYamlContext(doc, 0);
    expect(ctx.kind).toBeNull();
    expect(ctx.path).toEqual([]);
    expect(ctx.isKey).toBe(true);
    expect(ctx.indent).toBe(0);
  });
});
