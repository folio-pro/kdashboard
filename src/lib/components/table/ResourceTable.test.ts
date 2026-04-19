import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource } from "$lib/types";
import {
  filterResources,
  sortResources,
  computeAllSelected,
  computeSomeSelected,
  handleSelectAll,
  formatCopyFeedback,
  clampColumnWidth,
} from "./resource-table";

// ---------------------------------------------------------------------------
// Helpers: build minimal Resource objects for testing
// ---------------------------------------------------------------------------

function makeResource(overrides: Partial<{
  name: string;
  namespace: string;
  uid: string;
  creation_timestamp: string;
  kind: string;
  phase: string;
  containerStatuses: unknown[];
  data: Record<string, unknown> | null;
  specType: string;
  type: string;
}>): Resource {
  const o = {
    name: "default",
    namespace: "default",
    uid: crypto.randomUUID(),
    creation_timestamp: "2026-01-01T00:00:00Z",
    kind: "Pod",
    phase: "Running",
    containerStatuses: undefined as unknown[] | undefined,
    data: undefined as Record<string, unknown> | null | undefined,
    specType: undefined as string | undefined,
    type: undefined as string | undefined,
    ...overrides,
  };

  return {
    kind: o.kind,
    api_version: "v1",
    metadata: {
      name: o.name,
      namespace: o.namespace,
      uid: o.uid,
      creation_timestamp: o.creation_timestamp,
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: o.specType ? { type: o.specType } : {},
    status: {
      phase: o.phase,
      ...(o.containerStatuses ? { containerStatuses: o.containerStatuses } : {}),
    },
    ...(o.data !== undefined ? { data: o.data ?? undefined } : {}),
    ...(o.type !== undefined ? { type: o.type } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResourceTable — text filter", () => {
  const items = [
    makeResource({ name: "nginx-abc", namespace: "production" }),
    makeResource({ name: "redis-xyz", namespace: "staging" }),
    makeResource({ name: "postgres-db", namespace: "production" }),
    makeResource({ name: "UPPER-CASE", namespace: "default" }),
  ];

  test("empty filter returns all items", () => {
    expect(filterResources(items, "")).toHaveLength(4);
  });

  test("filters by name case-insensitively", () => {
    const result = filterResources(items, "NGINX");
    expect(result).toHaveLength(1);
    expect(result[0].metadata.name).toBe("nginx-abc");
  });

  test("filters by namespace case-insensitively", () => {
    const result = filterResources(items, "PRODUCTION");
    expect(result).toHaveLength(2);
  });

  test("partial match works", () => {
    const result = filterResources(items, "red");
    expect(result).toHaveLength(1);
    expect(result[0].metadata.name).toBe("redis-xyz");
  });

  test("no match returns empty array", () => {
    expect(filterResources(items, "nonexistent")).toHaveLength(0);
  });

  test("empty resources with active filter returns empty", () => {
    expect(filterResources([], "something")).toHaveLength(0);
  });

  test("matches resource with uppercase name using lowercase filter", () => {
    const result = filterResources(items, "upper");
    expect(result).toHaveLength(1);
    expect(result[0].metadata.name).toBe("UPPER-CASE");
  });

  test("filters against namespace when name does not match", () => {
    const result = filterResources(items, "stag");
    expect(result).toHaveLength(1);
    expect(result[0].metadata.name).toBe("redis-xyz");
  });
});

describe("ResourceTable — sorting by name", () => {
  const items = [
    makeResource({ name: "charlie" }),
    makeResource({ name: "alpha" }),
    makeResource({ name: "bravo" }),
  ];

  test("asc sorts A-Z", () => {
    const result = sortResources(items, "name", "asc");
    expect(result.map((r) => r.metadata.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("desc sorts Z-A", () => {
    const result = sortResources(items, "name", "desc");
    expect(result.map((r) => r.metadata.name)).toEqual(["charlie", "bravo", "alpha"]);
  });
});

describe("ResourceTable — sorting by namespace", () => {
  const items = [
    makeResource({ name: "a", namespace: "staging" }),
    makeResource({ name: "b", namespace: "default" }),
    makeResource({ name: "c", namespace: "production" }),
  ];

  test("asc sorts namespaces alphabetically", () => {
    const result = sortResources(items, "namespace", "asc");
    expect(result.map((r) => r.metadata.namespace)).toEqual(["default", "production", "staging"]);
  });

  test("desc sorts namespaces reverse alphabetically", () => {
    const result = sortResources(items, "namespace", "desc");
    expect(result.map((r) => r.metadata.namespace)).toEqual(["staging", "production", "default"]);
  });

  test("missing namespace treated as empty string", () => {
    const withMissing = [
      makeResource({ name: "a", namespace: "beta" }),
      { ...makeResource({ name: "b" }), metadata: { ...makeResource({ name: "b" }).metadata, namespace: undefined } } as unknown as Resource,
    ];
    const result = sortResources(withMissing, "namespace", "asc");
    // empty string sorts before "beta"
    expect(result[0].metadata.name).toBe("b");
  });
});

describe("ResourceTable — sorting by status", () => {
  const items = [
    makeResource({ name: "a", phase: "Running" }),
    makeResource({ name: "b", phase: "Failed" }),
    makeResource({ name: "c", phase: "Pending" }),
  ];

  test("asc sorts status alphabetically", () => {
    const result = sortResources(items, "status", "asc");
    expect(result.map((r) => r.status?.phase)).toEqual(["Failed", "Pending", "Running"]);
  });

  test("desc sorts status reverse", () => {
    const result = sortResources(items, "status", "desc");
    expect(result.map((r) => r.status?.phase)).toEqual(["Running", "Pending", "Failed"]);
  });
});

describe("ResourceTable — sorting by age (ISO timestamps)", () => {
  const items = [
    makeResource({ name: "old", creation_timestamp: "2024-01-01T00:00:00Z" }),
    makeResource({ name: "new", creation_timestamp: "2026-06-15T00:00:00Z" }),
    makeResource({ name: "mid", creation_timestamp: "2025-06-01T00:00:00Z" }),
  ];

  test("asc age = newest first (larger timestamp first via inverted localeCompare)", () => {
    const result = sortResources(items, "age", "asc");
    expect(result.map((r) => r.metadata.name)).toEqual(["new", "mid", "old"]);
  });

  test("desc age = oldest first", () => {
    const result = sortResources(items, "age", "desc");
    expect(result.map((r) => r.metadata.name)).toEqual(["old", "mid", "new"]);
  });
});

describe("ResourceTable — sorting by restarts", () => {
  const items = [
    makeResource({
      name: "high",
      containerStatuses: [{ restartCount: 10 }, { restartCount: 5 }],
    }),
    makeResource({
      name: "low",
      containerStatuses: [{ restartCount: 1 }],
    }),
    makeResource({
      name: "zero",
      containerStatuses: [{ restartCount: 0 }],
    }),
  ];

  test("asc sorts low to high restart count", () => {
    const result = sortResources(items, "restarts", "asc");
    expect(result.map((r) => r.metadata.name)).toEqual(["zero", "low", "high"]);
  });

  test("desc sorts high to low restart count", () => {
    const result = sortResources(items, "restarts", "desc");
    expect(result.map((r) => r.metadata.name)).toEqual(["high", "low", "zero"]);
  });

  test("missing containerStatuses treated as 0 restarts", () => {
    const withMissing = [
      makeResource({ name: "some", containerStatuses: [{ restartCount: 3 }] }),
      makeResource({ name: "none" }), // no containerStatuses
    ];
    const result = sortResources(withMissing, "restarts", "asc");
    expect(result[0].metadata.name).toBe("none");
    expect(result[1].metadata.name).toBe("some");
  });

  test("missing restartCount in container treated as 0", () => {
    const withMissing = [
      makeResource({ name: "a", containerStatuses: [{}] }),
      makeResource({ name: "b", containerStatuses: [{ restartCount: 2 }] }),
    ];
    const result = sortResources(withMissing, "restarts", "asc");
    expect(result[0].metadata.name).toBe("a");
  });
});

describe("ResourceTable — sorting by data count", () => {
  test("sorts by number of keys in .data", () => {
    const items = [
      makeResource({ name: "three", data: { a: 1, b: 2, c: 3 } }),
      makeResource({ name: "one", data: { x: 1 } }),
      makeResource({ name: "two", data: { m: 1, n: 2 } }),
    ];
    const result = sortResources(items, "data", "asc");
    expect(result.map((r) => r.metadata.name)).toEqual(["one", "two", "three"]);
  });

  test("desc data sort", () => {
    const items = [
      makeResource({ name: "one", data: { x: 1 } }),
      makeResource({ name: "three", data: { a: 1, b: 2, c: 3 } }),
    ];
    const result = sortResources(items, "data", "desc");
    expect(result[0].metadata.name).toBe("three");
  });

  test("null data treated as 0 keys", () => {
    const items = [
      makeResource({ name: "has-data", data: { a: 1 } }),
      makeResource({ name: "no-data", data: null }),
    ];
    const result = sortResources(items, "data", "asc");
    expect(result[0].metadata.name).toBe("no-data");
  });

  test("missing data entirely treated as 0 keys", () => {
    const items = [
      makeResource({ name: "has-data", data: { a: 1, b: 2 } }),
      makeResource({ name: "no-data" }), // no data property
    ];
    const result = sortResources(items, "data", "asc");
    expect(result[0].metadata.name).toBe("no-data");
  });
});

describe("ResourceTable — sorting by type", () => {
  test("sorts by spec.type", () => {
    const items = [
      makeResource({ name: "np", specType: "NodePort" }),
      makeResource({ name: "cip", specType: "ClusterIP" }),
      makeResource({ name: "lb", specType: "LoadBalancer" }),
    ];
    const result = sortResources(items, "type", "asc");
    expect(result.map((r) => r.metadata.name)).toEqual(["cip", "lb", "np"]);
  });

  test("falls back to resource.type when spec.type is missing", () => {
    const items = [
      makeResource({ name: "opaque", type: "Opaque" }),
      makeResource({ name: "tls", type: "kubernetes.io/tls" }),
    ];
    const result = sortResources(items, "type", "asc");
    // "kubernetes.io/tls" < "Opaque" in localeCompare
    expect(result[0].metadata.name).toBe("tls");
    expect(result[1].metadata.name).toBe("opaque");
  });
});

describe("ResourceTable — unknown sort column falls back to name", () => {
  test("sorts by name when column is unrecognised", () => {
    const items = [
      makeResource({ name: "banana" }),
      makeResource({ name: "apple" }),
    ];
    const result = sortResources(items, "unknownColumn", "asc");
    expect(result[0].metadata.name).toBe("apple");
  });
});

describe("ResourceTable — selection state", () => {
  const r1 = makeResource({ name: "a", uid: "uid-1" });
  const r2 = makeResource({ name: "b", uid: "uid-2" });
  const r3 = makeResource({ name: "c", uid: "uid-3" });
  const filtered = [r1, r2, r3];

  test("allSelected is false when no rows selected", () => {
    expect(computeAllSelected(filtered, new Set())).toBe(false);
  });

  test("someSelected is false when no rows selected", () => {
    expect(computeSomeSelected(filtered, new Set())).toBe(false);
  });

  test("someSelected is true with partial selection", () => {
    expect(computeSomeSelected(filtered, new Set(["uid-1"]))).toBe(true);
  });

  test("allSelected is false with partial selection", () => {
    expect(computeAllSelected(filtered, new Set(["uid-1", "uid-2"]))).toBe(false);
  });

  test("allSelected is true when all filtered rows selected", () => {
    expect(computeAllSelected(filtered, new Set(["uid-1", "uid-2", "uid-3"]))).toBe(true);
  });

  test("someSelected is true when all rows selected", () => {
    expect(computeSomeSelected(filtered, new Set(["uid-1", "uid-2", "uid-3"]))).toBe(true);
  });

  test("allSelected is false when filteredResources is empty", () => {
    expect(computeAllSelected([], new Set(["uid-1"]))).toBe(false);
  });

  test("someSelected is false when filteredResources is empty", () => {
    expect(computeSomeSelected([], new Set(["uid-1"]))).toBe(false);
  });

  test("allSelected ignores extra selected uids not in filtered", () => {
    expect(
      computeAllSelected(filtered, new Set(["uid-1", "uid-2", "uid-3", "uid-extra"])),
    ).toBe(true);
  });
});

describe("ResourceTable — handleSelectAll", () => {
  const r1 = makeResource({ name: "a", uid: "uid-1" });
  const r2 = makeResource({ name: "b", uid: "uid-2" });
  const filtered = [r1, r2];

  test("selects all when not all selected", () => {
    const result = handleSelectAll(false, filtered);
    expect(result.size).toBe(2);
    expect(result.has("uid-1")).toBe(true);
    expect(result.has("uid-2")).toBe(true);
  });

  test("clears selection when all already selected", () => {
    const result = handleSelectAll(true, filtered);
    expect(result.size).toBe(0);
  });

  test("select all on empty list gives empty set", () => {
    const result = handleSelectAll(false, []);
    expect(result.size).toBe(0);
  });
});

describe("ResourceTable — formatCopyFeedback", () => {
  test("short value is shown verbatim", () => {
    expect(formatCopyFeedback("hello")).toBe("Copied: hello");
  });

  test("exactly 40 chars is NOT truncated", () => {
    const val = "a".repeat(40);
    expect(formatCopyFeedback(val)).toBe(`Copied: ${val}`);
  });

  test("41 chars is truncated with ellipsis", () => {
    const val = "a".repeat(41);
    expect(formatCopyFeedback(val)).toBe(`Copied: ${"a".repeat(40)}...`);
  });

  test("long value shows first 40 chars + ellipsis", () => {
    const val = "abcdefghij".repeat(10); // 100 chars
    expect(formatCopyFeedback(val)).toBe(`Copied: ${val.slice(0, 40)}...`);
  });

  test("empty string", () => {
    expect(formatCopyFeedback("")).toBe("Copied: ");
  });
});

describe("ResourceTable — column width clamping", () => {
  test("width above minimum is unchanged", () => {
    expect(clampColumnWidth(200)).toBe(200);
  });

  test("width exactly at minimum is unchanged", () => {
    expect(clampColumnWidth(40)).toBe(40);
  });

  test("width below minimum is clamped to 40", () => {
    expect(clampColumnWidth(10)).toBe(40);
  });

  test("zero width is clamped to 40", () => {
    expect(clampColumnWidth(0)).toBe(40);
  });

  test("negative width is clamped to 40", () => {
    expect(clampColumnWidth(-50)).toBe(40);
  });
});

describe("ResourceTable — filter + sort integration", () => {
  const items = [
    makeResource({ name: "z-pod", namespace: "default" }),
    makeResource({ name: "a-pod", namespace: "default" }),
    makeResource({ name: "m-pod", namespace: "kube-system" }),
  ];

  test("filter then sort gives correct order", () => {
    const filtered = filterResources(items, "default");
    const sorted = sortResources(filtered, "name", "asc");
    expect(sorted.map((r) => r.metadata.name)).toEqual(["a-pod", "z-pod"]);
  });

  test("filter to empty then sort returns empty", () => {
    const filtered = filterResources(items, "nonexistent");
    const sorted = sortResources(filtered, "name", "asc");
    expect(sorted).toHaveLength(0);
  });
});
