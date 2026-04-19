import { describe, expect, test } from "bun:test";
import { getFieldInfo, resolveSchemaAtPath } from "./k8s-schema-resolver";

describe("resolveSchemaAtPath — array traversal", () => {
  test("numeric segment stays within the same field map (behavior pin)", () => {
    // Design: numeric segments are skipped. When a path has a numeric index
    // WITHOUT the preceding array key, the index alone does not navigate.
    // This test pins that behavior so a refactor does not silently change it.
    const fields = resolveSchemaAtPath("Pod", ["spec", "containers", "0"]);
    expect(fields).not.toBeNull();
    expect(fields?.name?.required).toBe(true);

    // Same path without the numeric index also resolves (numeric is a no-op):
    const fieldsNoIndex = resolveSchemaAtPath("Pod", ["spec", "containers"]);
    // Without the index, we land on the array field's item children (same map):
    expect(fieldsNoIndex).not.toBeNull();
    expect(fieldsNoIndex?.name?.required).toBe(true);
  });

  test("double numeric segment does not double-descend", () => {
    // Two consecutive numeric indices on an object-array descend once.
    const fields = resolveSchemaAtPath("Pod", ["spec", "containers", "0", "0"]);
    expect(fields).not.toBeNull();
    expect(fields?.name?.required).toBe(true);
  });

  test("deep nested array item fields resolve", () => {
    const fields = resolveSchemaAtPath("Pod", [
      "spec",
      "containers",
      "0",
      "ports",
      "0",
    ]);
    expect(fields).not.toBeNull();
    expect(fields?.containerPort?.required).toBe(true);
    expect(fields?.protocol?.enum).toContain("TCP");
    expect(fields?.protocol?.enum).toContain("UDP");
  });
});

describe("resolveSchemaAtPath — null paths", () => {
  test("returns null for unknown kind even with empty path", () => {
    expect(resolveSchemaAtPath("FooBar", [])).toBeNull();
  });

  test("returns null when a mid-path key does not exist", () => {
    expect(resolveSchemaAtPath("Pod", ["spec", "doesNotExist"])).toBeNull();
  });

  test("returns null when path descends past a leaf string field", () => {
    // restartPolicy is a string leaf; descending past it should return null.
    expect(resolveSchemaAtPath("Pod", ["spec", "restartPolicy"])).toBeNull();
    expect(resolveSchemaAtPath("Pod", ["spec", "restartPolicy", "child"])).toBeNull();
  });

  test("returns null for an array field of non-object items", () => {
    // hostAliases.ip-like arrays or string arrays should not descend into children.
    // Service.spec.externalIPs is string[]; walking past it returns null.
    const direct = resolveSchemaAtPath("Service", ["spec", "externalIPs"]);
    expect(direct).toBeNull();
  });
});

describe("resolveSchemaAtPath — entry points", () => {
  test("empty path returns top-level schema for known kind", () => {
    const fields = resolveSchemaAtPath("Pod", []);
    expect(fields).not.toBeNull();
    expect(fields?.apiVersion).toBeDefined();
    expect(fields?.kind).toBeDefined();
    expect(fields?.metadata).toBeDefined();
    expect(fields?.spec).toBeDefined();
  });

  test("resolves metadata object children (common to all kinds)", () => {
    const fields = resolveSchemaAtPath("Deployment", ["metadata"]);
    expect(fields).not.toBeNull();
    expect(fields?.name?.required).toBe(true);
    expect(fields?.namespace).toBeDefined();
  });
});

describe("getFieldInfo", () => {
  test("returns the field when kind, path, and key are valid", () => {
    const field = getFieldInfo("Pod", ["spec", "containers", "0"], "image");
    expect(field).not.toBeNull();
    expect(field?.required).toBe(true);
    expect(field?.type).toBe("string");
  });

  test("returns null for unknown kind", () => {
    expect(getFieldInfo("UnknownKind", ["metadata"], "name")).toBeNull();
  });

  test("returns null when the path is invalid", () => {
    expect(getFieldInfo("Pod", ["spec", "doesNotExist"], "anything")).toBeNull();
  });

  test("returns null when the key does not exist at a valid path", () => {
    expect(getFieldInfo("Pod", ["metadata"], "thisFieldDoesNotExist")).toBeNull();
  });

  test("returns enum info for fields that declare enum values", () => {
    const field = getFieldInfo("Pod", ["spec", "containers", "0", "ports", "0"], "protocol");
    expect(field).not.toBeNull();
    expect(field?.enum).toEqual(expect.arrayContaining(["TCP", "UDP"]));
  });
});
