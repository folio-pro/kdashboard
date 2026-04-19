import { describe, expect, test } from "bun:test";
import {
  COMMON_ANNOTATIONS,
  COMMON_LABELS,
  KIND_API_VERSIONS,
  getFieldInfo,
  resolveSchemaAtPath,
} from "./k8s-schema";

describe("resolveSchemaAtPath", () => {
  test("returns null for unknown kinds", () => {
    expect(resolveSchemaAtPath("UnknownKind", ["spec"])).toBeNull();
  });

  test("resolves deeply nested object fields", () => {
    const fields = resolveSchemaAtPath("Deployment", [
      "spec",
      "template",
      "spec",
      "containers",
      "0",
    ]);

    expect(fields).not.toBeNull();
    expect(fields?.name?.required).toBe(true);
    expect(fields?.image?.required).toBe(true);
  });

  test("resolves array item children after numeric segments", () => {
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
  });

  test("returns null when path points to a leaf value", () => {
    expect(resolveSchemaAtPath("Pod", ["spec", "restartPolicy"])).toBeNull();
  });
});

describe("getFieldInfo", () => {
  test("returns info for valid fields", () => {
    const field = getFieldInfo("Pod", ["metadata"], "name");
    expect(field).not.toBeNull();
    expect(field?.required).toBe(true);
    expect(field?.type).toBe("string");
  });

  test("returns null for unknown field", () => {
    expect(getFieldInfo("Pod", ["metadata"], "doesNotExist")).toBeNull();
  });
});

describe("schema constants", () => {
  test("contains expected api versions", () => {
    expect(KIND_API_VERSIONS.Pod).toEqual(["v1"]);
    expect(KIND_API_VERSIONS.CronJob).toContain("batch/v1");
  });

  test("contains common label and annotation hints", () => {
    expect(COMMON_LABELS).toContain("app.kubernetes.io/name");
    expect(COMMON_ANNOTATIONS).toContain("prometheus.io/scrape");
  });
});
