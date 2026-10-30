import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource } from "$lib/types";
import {
  filterResources,
  sortResources,
  computeAllSelected,
  computeSomeSelected,
  handleSelectAll,
  clampColumnWidth,
  applyFilterState,
  countActiveFilters,
  countViews,
  compileFilterState,
  hasSortKey,
} from "./resource-table";
import type { CellContext } from "./cell-values";
import {
  columnsByType,
  defaultColumns,
  minimumTableWidth,
  GUTTER_WIDTH,
  NAME_MIN_WIDTH,
  UNSIZED_MIN_WIDTH,
} from "./table-columns";

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

describe("ResourceTable — events", () => {
  const makeEvent = (name: string, spec: Record<string, unknown>): Resource => ({
    ...makeResource({ name, kind: "Event" }),
    spec,
  });

  test("eventLastSeen sorts newest first on asc, oldest first on desc", () => {
    const items = [
      makeEvent("old", { lastTimestamp: "2026-01-01T00:00:00Z" }),
      makeEvent("new", { lastTimestamp: "2026-06-01T00:00:00Z" }),
      makeEvent("mid", { lastTimestamp: "2026-03-01T00:00:00Z" }),
    ];
    expect(sortResources(items, "eventLastSeen", "asc").map((r) => r.metadata.name))
      .toEqual(["new", "mid", "old"]);
    expect(sortResources(items, "eventLastSeen", "desc").map((r) => r.metadata.name))
      .toEqual(["old", "mid", "new"]);
  });

  test("eventLastSeen compares parsed times, not strings (fractional seconds)", () => {
    // Lexically "…00.500Z" < "…00Z", but it is the newer instant.
    const items = [
      makeEvent("whole", { eventTime: "2026-06-01T00:00:00Z" }),
      makeEvent("fractional", { eventTime: "2026-06-01T00:00:00.500Z" }),
    ];
    expect(sortResources(items, "eventLastSeen", "asc")[0].metadata.name).toBe("fractional");
  });

  test("eventLastSeen falls back to creation timestamp when unobserved", () => {
    const items = [
      makeEvent("observed", { lastTimestamp: "2026-06-01T00:00:00Z" }),
      { ...makeEvent("bare", {}), metadata: { ...makeResource({ name: "bare" }).metadata, name: "bare", creation_timestamp: "2026-07-01T00:00:00Z" } },
    ];
    expect(sortResources(items, "eventLastSeen", "asc")[0].metadata.name).toBe("bare");
  });

  test("eventReason sorts alphabetically", () => {
    const items = [
      makeEvent("b", { reason: "Pulled" }),
      makeEvent("a", { reason: "BackOff" }),
    ];
    expect(sortResources(items, "eventReason", "asc")[0].metadata.name).toBe("a");
  });

  test("filter matches event reason and message, but only for Events", () => {
    const items = [
      makeEvent("ev-1", { reason: "BackOff", message: "Back-off restarting container" }),
      makeEvent("ev-2", { reason: "Pulled", message: "Container image pulled" }),
      { ...makeResource({ name: "pod-1" }), spec: { reason: "BackOff" } },
    ];
    const hits = filterResources(items, "backoff");
    expect(hits.map((r) => r.metadata.name)).toEqual(["ev-1"]);
    expect(filterResources(items, "image pulled").map((r) => r.metadata.name)).toEqual(["ev-2"]);
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

// ---------------------------------------------------------------------------
// Every sortable column sorts by what it displays (#102)
// ---------------------------------------------------------------------------

/** A resource with the given name and arbitrary extra top-level parts. */
function raw(name: string, parts: Partial<Resource> & { owners?: Resource["metadata"]["owner_references"] } = {}): Resource {
  const { owners, ...rest } = parts;
  return {
    kind: "Pod",
    api_version: "v1",
    ...rest,
    metadata: {
      name,
      namespace: "default",
      uid: name,
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: owners ?? [],
      resource_version: "1",
      ...(rest.metadata ?? {}),
    },
  } as Resource;
}

const names = (rs: Resource[]) => rs.map((r) => r.metadata.name);

describe("ResourceTable — sort key coverage", () => {
  test("every sortable column in table-columns.ts has a sort key", () => {
    const sortable = new Set<string>();
    for (const cols of [...Object.values(columnsByType), defaultColumns]) {
      for (const c of cols) if (c.sortable) sortable.add(c.key);
    }
    const missing = [...sortable].filter((key) => !hasSortKey(key));
    expect(missing).toEqual([]);
  });
});

describe("ResourceTable — sorting by displayed Status", () => {
  const cs = (waiting?: string) => [
    waiting
      ? { name: "c", ready: false, restartCount: 3, state: { waiting: { reason: waiting } } }
      : { name: "c", ready: true, restartCount: 0, state: { running: {} } },
  ];

  test("pods sort by the kubectl label, not the phase", () => {
    const items = [
      raw("a-running", { status: { phase: "Running", containerStatuses: cs() } }),
      raw("b-crash", { status: { phase: "Running", containerStatuses: cs("CrashLoopBackOff") } }),
      raw("c-pending", { status: { phase: "Pending" } }),
    ];
    expect(names(sortResources(items, "status", "asc"))).toEqual(["b-crash", "c-pending", "a-running"]);
  });

  test("nodes sort by Ready / NotReady", () => {
    const node = (name: string, ready: string) =>
      raw(name, { kind: "Node", status: { conditions: [{ type: "Ready", status: ready }] } });
    const items = [node("a", "True"), node("b", "False"), node("c", "True")];
    expect(names(sortResources(items, "status", "asc"))).toEqual(["b", "a", "c"]);
    expect(names(sortResources(items, "status", "desc"))).toEqual(["a", "c", "b"]);
  });
});

describe("ResourceTable — sorting pod columns", () => {
  test("podReady sorts by ready fraction", () => {
    const pod = (name: string, ready: boolean[]) =>
      raw(name, { status: { containerStatuses: ready.map((r) => ({ ready: r, restartCount: 0 })) } });
    const items = [pod("full", [true, true]), pod("none", [false, false]), pod("half", [true, false])];
    expect(names(sortResources(items, "podReady", "asc"))).toEqual(["none", "half", "full"]);
    expect(names(sortResources(items, "podReady", "desc"))).toEqual(["full", "half", "none"]);
  });

  test("controlledBy sorts by owner", () => {
    const owned = (name: string, kind: string, owner: string) =>
      raw(name, { owners: [{ kind, name: owner, uid: owner, api_version: "apps/v1", controller: true }] as never });
    const items = [owned("a", "ReplicaSet", "web"), owned("b", "DaemonSet", "agent"), raw("c")];
    // ds/agent < rs/web; the unowned pod ("-") sorts first.
    expect(names(sortResources(items, "controlledBy", "asc"))).toEqual(["c", "b", "a"]);
  });

  test("node sorts by node name", () => {
    const on = (name: string, node: string) => raw(name, { spec: { nodeName: node } });
    const items = [on("a", "node-2"), on("b", "node-1"), on("c", "node-3")];
    expect(names(sortResources(items, "node", "asc"))).toEqual(["b", "a", "c"]);
  });
});

describe("ResourceTable — sorting deployment columns", () => {
  const deploy = (name: string, replicas: number, readyReplicas: number, current = replicas) =>
    raw(name, {
      kind: "Deployment",
      spec: { replicas },
      status: { readyReplicas, replicas: current, updatedReplicas: replicas },
    });

  test("deployReady sorts by ready fraction", () => {
    const items = [deploy("a", 3, 3), deploy("b", 3, 0), deploy("c", 4, 2)];
    expect(names(sortResources(items, "deployReady", "asc"))).toEqual(["b", "c", "a"]);
  });

  test("deployStatus sorts by the status label", () => {
    const items = [
      deploy("a", 3, 3),
      raw("b", { kind: "Deployment", spec: { replicas: 0 }, status: {} }),
      deploy("c", 3, 1),
    ];
    // Available < Progressing < Scaled to 0
    expect(names(sortResources(items, "deployStatus", "asc"))).toEqual(["a", "c", "b"]);
  });

  test("pods sorts numerically, not lexically", () => {
    const items = [deploy("a", 10, 10), deploy("b", 2, 2), deploy("c", 9, 9)];
    expect(names(sortResources(items, "pods", "asc"))).toEqual(["b", "c", "a"]);
  });
});

describe("ResourceTable — sorting service / ingress / scheduling columns", () => {
  test("endpoints sorts by ready fraction from the cell context", () => {
    const summaries: Record<string, CellContext["endpoints"]> = {
      a: { ready: 2, total: 2, terminating: 0 } as never,
      b: null,
      c: { ready: 1, total: 3, terminating: 0 } as never,
    };
    const items = [raw("a", { kind: "Service" }), raw("b", { kind: "Service" }), raw("c", { kind: "Service" })];
    const ctxFor = (r: Resource): CellContext => ({ ageTick: 0, endpoints: summaries[r.metadata.name] });
    expect(names(sortResources(items, "endpoints", "asc", ctxFor))).toEqual(["b", "c", "a"]);
  });

  test("the cell context is only built for columns that read it", () => {
    let calls = 0;
    const ctxFor = (): CellContext => {
      calls++;
      return { ageTick: 0 };
    };
    sortResources([raw("a"), raw("b")], "status", "asc", ctxFor);
    expect(calls).toBe(0);
  });

  test("ingressClass sorts by class", () => {
    const ing = (name: string, cls: string) => raw(name, { kind: "Ingress", spec: { ingressClassName: cls } });
    const items = [ing("a", "nginx"), ing("b", "alb"), ing("c", "traefik")];
    expect(names(sortResources(items, "ingressClass", "asc"))).toEqual(["b", "a", "c"]);
  });

  test("pcValue sorts numerically, negatives included", () => {
    const pc = (name: string, value: number) => raw(name, { kind: "PriorityClass", spec: { value } });
    const items = [pc("a", 1000), pc("b", -5), pc("c", 2000000000), pc("d", 200)];
    expect(names(sortResources(items, "pcValue", "asc"))).toEqual(["b", "d", "a", "c"]);
  });
});

describe("ResourceTable — sort ties and key computation", () => {
  test("equal keys break by name ascending in both directions", () => {
    const items = [
      makeResource({ name: "c", namespace: "x" }),
      makeResource({ name: "a", namespace: "x" }),
      makeResource({ name: "b", namespace: "w" }),
    ];
    expect(names(sortResources(items, "namespace", "asc"))).toEqual(["b", "a", "c"]);
    expect(names(sortResources(items, "namespace", "desc"))).toEqual(["a", "c", "b"]);
  });

  test("each row's key is computed once per sort", () => {
    let reads = 0;
    const items = Array.from({ length: 200 }, (_, i) => {
      const r = makeResource({ name: `p-${i}` });
      const status = { phase: "Running" } as Record<string, unknown>;
      Object.defineProperty(status, "containerStatuses", {
        get() {
          reads++;
          return [{ restartCount: (i * 7919) % 200 }];
        },
      });
      return { ...r, status } as Resource;
    });
    sortResources(items, "restarts", "asc");
    expect(reads).toBe(items.length);
  });

  test("does not mutate the input array", () => {
    const items = [makeResource({ name: "b" }), makeResource({ name: "a" })];
    sortResources(items, "name", "asc");
    expect(names(items)).toEqual(["b", "a"]);
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

describe("ResourceTable — filter pipeline", () => {
  const ctxFor = () => ({ ageTick: 0 });
  const pod = (name: string, phase: string, restarts: number, waitingReason?: string): Resource =>
    ({
      kind: "Pod",
      metadata: { name, namespace: "default", uid: name, creation_timestamp: "2024-01-01T00:00:00Z" },
      spec: {},
      status: {
        phase,
        containerStatuses: [
          { name: "c", ready: true, restartCount: restarts, image: "x", state: waitingReason ? { waiting: { reason: waitingReason } } : {} },
        ],
      },
    }) as unknown as Resource;
  const items = [pod("api-1", "Running", 0), pod("api-2", "Running", 14, "CrashLoopBackOff"), pod("job-1", "Succeeded", 0)];

  test("no filters returns the same array", () => {
    expect(applyFilterState(items, { statFilter: null, facets: [], text: "" }, "pods", ctxFor)).toBe(items);
  });
  test("stat chip, then facets, then text", () => {
    expect(applyFilterState(items, { statFilter: "running", facets: [], text: "" }, "pods", ctxFor).map((r) => r.metadata.name)).toEqual(["api-1"]);
    expect(applyFilterState(items, { statFilter: "needsAttention", facets: [], text: "" }, "pods", ctxFor).map((r) => r.metadata.name)).toEqual(["api-2"]);
    expect(applyFilterState(items, { statFilter: null, facets: [{ key: "restarts", op: ">", value: "0" }], text: "" }, "pods", ctxFor).map((r) => r.metadata.name)).toEqual(["api-2"]);
    expect(applyFilterState(items, { statFilter: null, facets: [], text: "job" }, "pods", ctxFor).map((r) => r.metadata.name)).toEqual(["job-1"]);
    // Status is the effective state, so api-2 (CrashLoopBackOff) is no longer "running".
    expect(applyFilterState(items, { statFilter: null, facets: [{ key: "status", op: ":", value: "running" }], text: "api" }, "pods", ctxFor).map((r) => r.metadata.name)).toEqual(["api-1"]);
    expect(applyFilterState(items, { statFilter: null, facets: [{ key: "status", op: ":", value: "crash" }], text: "api" }, "pods", ctxFor).map((r) => r.metadata.name)).toEqual(["api-2"]);
  });
  test("compileFilterState returns null for the empty state and a predicate otherwise", () => {
    expect(compileFilterState({ statFilter: null, facets: [], text: "" }, "pods", ctxFor)).toBeNull();
    const test = compileFilterState({ statFilter: "running", facets: [], text: "api" }, "pods", ctxFor)!;
    expect(items.filter(test).map((r) => r.metadata.name)).toEqual(["api-1"]);
  });
  test("countViews agrees with applyFilterState for every view, in one pass", () => {
    const views = [
      { id: "all", state: { statFilter: null, facets: [], text: "" } },
      { id: "attention", state: { statFilter: "needsAttention", facets: [], text: "" } },
      { id: "restarting", state: { statFilter: null, facets: [{ key: "restarts", op: ">" as const, value: "0" }], text: "" } },
      { id: "jobs", state: { statFilter: null, facets: [], text: "job" } },
    ];
    let ctxCalls = 0;
    const countingCtx = () => {
      ctxCalls++;
      return { ageTick: 0 };
    };
    const counts = countViews(items, views, "pods", countingCtx);
    for (const v of views) {
      expect(counts[v.id]).toBe(applyFilterState(items, v.state, "pods", ctxFor).length);
    }
    expect(counts).toEqual({ all: 3, attention: 1, restarting: 1, jobs: 1 });
    // One context per row, shared by every facet view — not one per row per view.
    expect(ctxCalls).toBe(items.length);
  });
  test("countViews with only the All view never walks the items", () => {
    const counts = countViews(items, [{ id: "all", state: { statFilter: null, facets: [], text: "" } }], "pods", () => {
      throw new Error("should not build a context");
    });
    expect(counts).toEqual({ all: 3 });
  });
  test("countActiveFilters counts each kind once", () => {
    expect(countActiveFilters({ facets: [], text: "", statFilter: null })).toBe(0);
    expect(countActiveFilters({ facets: [{ key: "a", op: ":", value: "b" }, { key: "c", op: ":", value: "d" }], text: "x", statFilter: "running" })).toBe(4);
  });
});

describe("ResourceTable — minimum table width", () => {
  test("sized columns add up; unsized ones get the floor", () => {
    const cols = [
      { key: "name", label: "Name", sortable: true },
      { key: "status", label: "Status", sortable: true, width: "120px" },
      { key: "node", label: "Node", sortable: true },
    ];
    expect(minimumTableWidth(cols)).toBe(GUTTER_WIDTH + 120 + NAME_MIN_WIDTH + UNSIZED_MIN_WIDTH);
    expect(minimumTableWidth([])).toBe(GUTTER_WIDTH);
  });
});
