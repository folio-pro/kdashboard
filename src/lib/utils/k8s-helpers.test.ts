import { describe, expect, test } from "bun:test";
import { getContainerState, resolveJsonPath, toggleSetItem } from "./k8s-helpers";

describe("getContainerState", () => {
  test("returns Running when running key is present", () => {
    expect(getContainerState({ running: { startedAt: "2026-01-01T00:00:00Z" } })).toBe("Running");
  });

  test("returns waiting reason when present", () => {
    expect(getContainerState({ waiting: { reason: "ImagePullBackOff" } })).toBe("ImagePullBackOff");
  });

  test("returns Waiting fallback when waiting has no reason", () => {
    expect(getContainerState({ waiting: {} })).toBe("Waiting");
  });

  test("returns terminated reason when present", () => {
    expect(getContainerState({ terminated: { reason: "Completed", exitCode: 0 } })).toBe(
      "Completed",
    );
  });

  test("returns Terminated fallback when terminated has no reason", () => {
    expect(getContainerState({ terminated: {} })).toBe("Terminated");
  });

  test("returns Unknown when no known state key is present", () => {
    expect(getContainerState({})).toBe("Unknown");
  });

  test("Running wins over other keys when both present (order of precedence)", () => {
    expect(getContainerState({ running: {}, waiting: { reason: "X" } })).toBe("Running");
  });
});

describe("toggleSetItem", () => {
  test("adds missing key and returns a new Set", () => {
    const original = new Set(["a"]);
    const next = toggleSetItem(original, "b");
    expect(next.has("a")).toBe(true);
    expect(next.has("b")).toBe(true);
    expect(next).not.toBe(original);
    expect(original.has("b")).toBe(false);
  });

  test("removes existing key and returns a new Set", () => {
    const original = new Set(["a", "b"]);
    const next = toggleSetItem(original, "a");
    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(true);
    expect(original.has("a")).toBe(true);
  });

  test("round-trip toggle returns equivalent Set", () => {
    const original = new Set(["x"]);
    const toggled = toggleSetItem(original, "x");
    const back = toggleSetItem(toggled, "x");
    expect(back.has("x")).toBe(true);
    expect(back.size).toBe(1);
  });
});

describe("resolveJsonPath", () => {
  const base = {
    metadata: { name: "nginx-1", namespace: "default" },
    status: {
      phase: "Running",
      replicas: 3,
      ready: true,
      containerStatuses: [{ name: "web", ready: true }],
    },
    spec: {
      replicas: 5,
      template: { spec: { containers: [{ name: "web", image: "nginx:1.25" }] } },
    },
  };

  test("resolves .metadata.name", () => {
    expect(resolveJsonPath(base, ".metadata.name")).toBe("nginx-1");
  });

  test("resolves .metadata.namespace", () => {
    expect(resolveJsonPath(base, ".metadata.namespace")).toBe("default");
  });

  test("returns empty string for unknown metadata field", () => {
    expect(resolveJsonPath(base, ".metadata.labels")).toBe("");
  });

  test("returns empty string when metadata.name is missing", () => {
    expect(resolveJsonPath({ metadata: {} }, ".metadata.name")).toBe("");
  });

  test("resolves a top-level string in status", () => {
    expect(resolveJsonPath(base, ".status.phase")).toBe("Running");
  });

  test("stringifies numeric values", () => {
    expect(resolveJsonPath(base, ".status.replicas")).toBe("3");
  });

  test("stringifies boolean values", () => {
    expect(resolveJsonPath(base, ".status.ready")).toBe("true");
  });

  test("resolves an array element by numeric index", () => {
    expect(resolveJsonPath(base, ".status.containerStatuses.0.name")).toBe("web");
  });

  test("resolves nested spec path", () => {
    expect(resolveJsonPath(base, ".spec.template.spec.containers.0.image")).toBe("nginx:1.25");
  });

  test("JSON-stringifies object leaves", () => {
    const result = resolveJsonPath(base, ".status.containerStatuses.0");
    expect(result).toBe(JSON.stringify(base.status.containerStatuses[0]));
  });

  test("returns empty string when status is missing", () => {
    expect(resolveJsonPath({ metadata: {} }, ".status.phase")).toBe("");
  });

  test("returns empty string when spec is missing", () => {
    expect(resolveJsonPath({ metadata: {} }, ".spec.replicas")).toBe("");
  });

  test("returns empty string when intermediate key is missing", () => {
    expect(resolveJsonPath(base, ".spec.template.doesNotExist.value")).toBe("");
  });

  test("returns empty string when root path is neither status, spec, nor metadata", () => {
    expect(resolveJsonPath(base, ".unknown.field")).toBe("");
  });

  test("accepts path without leading dot", () => {
    expect(resolveJsonPath(base, "status.phase")).toBe("Running");
  });

  test("returns empty string for null intermediate value", () => {
    const r = { metadata: {}, status: { nested: null as unknown as Record<string, unknown> } };
    expect(resolveJsonPath(r, ".status.nested.field")).toBe("");
  });
});
