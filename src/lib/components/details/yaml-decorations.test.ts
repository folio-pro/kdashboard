import { describe, expect, test } from "bun:test";

import {
  _lastTagColon as lastTagColon,
  _ROOT_KEYS as ROOT_KEYS,
  _KEY_AT_LINE_START as KEY_AT_LINE_START,
  _IMAGE_VALUE as IMAGE_VALUE,
  _OPAQUE_VALUE as OPAQUE_VALUE,
  _INDENT_UNIT as INDENT_UNIT,
} from "./yaml-decorations";

describe("lastTagColon", () => {
  test("finds the tag separator", () => {
    const value = "nginx:1.27";
    expect(value.slice(lastTagColon(value))).toBe(":1.27");
  });

  test("finds the tag on a namespaced image", () => {
    const value = "docker.io/library/nginx:1.27";
    expect(value.slice(lastTagColon(value))).toBe(":1.27");
  });

  test("ignores a registry port with no tag", () => {
    // `registry:5000/app` — the colon introduces a port, not a tag.
    expect(lastTagColon("registry:5000/app")).toBe(-1);
  });

  test("finds the tag after a registry port", () => {
    const value = "registry:5000/app:2.1";
    expect(value.slice(lastTagColon(value))).toBe(":2.1");
  });

  test("returns -1 for an untagged image", () => {
    expect(lastTagColon("nginx")).toBe(-1);
  });
});

describe("ROOT_KEYS", () => {
  test("covers the structural top-level keys", () => {
    for (const key of ["apiVersion", "kind", "metadata", "spec", "status"]) {
      expect(ROOT_KEYS.has(key)).toBe(true);
    }
  });

  test("does not include ordinary nested keys", () => {
    expect(ROOT_KEYS.has("replicas")).toBe(false);
    expect(ROOT_KEYS.has("image")).toBe(false);
  });
});

describe("KEY_AT_LINE_START", () => {
  test("captures indentation and key separately", () => {
    const m = "  replicas: 3".match(KEY_AT_LINE_START);
    expect(m?.[1]).toBe("  ");
    expect(m?.[2]).toBe("replicas");
  });

  test("matches a key with no value", () => {
    expect("spec:".match(KEY_AT_LINE_START)?.[2]).toBe("spec");
  });

  test("does not match a sequence entry", () => {
    expect("  - name: x".match(KEY_AT_LINE_START)).toBeNull();
  });

  test("does not match a bare value", () => {
    expect("nginx".match(KEY_AT_LINE_START)).toBeNull();
  });
});

describe("IMAGE_VALUE", () => {
  test("captures the image reference", () => {
    expect("      image: nginx:1.27".match(IMAGE_VALUE)?.[2]).toBe("nginx:1.27");
  });

  test("does not match imagePullPolicy", () => {
    expect("      imagePullPolicy: Always".match(IMAGE_VALUE)).toBeNull();
  });

  test("does not match a multi-word value", () => {
    expect("      image: a b".match(IMAGE_VALUE)).toBeNull();
  });
});

describe("OPAQUE_VALUE", () => {
  const blob = "A".repeat(60);

  test("captures a long base64 payload", () => {
    expect(`  password: ${blob}`.match(OPAQUE_VALUE)?.[1]).toBe(blob);
  });

  test("accepts base64 padding", () => {
    const padded = `${"B".repeat(50)}==`;
    expect(`  key: ${padded}`.match(OPAQUE_VALUE)?.[1]).toBe(padded);
  });

  test("ignores a short value", () => {
    expect("  password: hunter2".match(OPAQUE_VALUE)).toBeNull();
  });

  test("ignores an unindented key", () => {
    expect(`password: ${blob}`.match(OPAQUE_VALUE)).toBeNull();
  });
});

describe("INDENT_UNIT", () => {
  test("matches the editor's two-space indent", () => {
    // codemirror-extensions.ts configures indentUnit.of("  ").
    expect(INDENT_UNIT).toBe(2);
  });
});
