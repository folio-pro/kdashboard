import { describe, expect, mock, test } from "bun:test";
import {
  crdTableColumns,
  crdCellText,
  filterCrdResources,
  sortCrdResources,
  moveRowIndex,
  crdRowActions,
} from "./crd-table.logic.js";
import type { CrdColumn, Resource } from "$lib/types/index.js";

const PRINTER: CrdColumn[] = [
  { name: "Phase", json_path: ".status.phase", column_type: "string", description: "" },
  { name: "Replicas", json_path: ".spec.replicas", column_type: "integer", description: "" },
];

function res(name: string, opts: { ns?: string; phase?: string; replicas?: number; created?: string } = {}): Resource {
  return {
    kind: "Widget",
    api_version: "example.com/v1",
    metadata: {
      name,
      namespace: opts.ns,
      uid: `uid-${name}`,
      creation_timestamp: opts.created ?? "2026-01-01T00:00:00Z",
    },
    spec: opts.replicas === undefined ? {} : { replicas: opts.replicas },
    status: opts.phase ? { phase: opts.phase } : {},
  } as unknown as Resource;
}

describe("crdTableColumns", () => {
  test("name, namespace, one column per printer column, then age", () => {
    const cols = crdTableColumns(PRINTER, { showNamespace: true });
    expect(cols.map((c) => c.label)).toEqual(["Name", "Namespace", "Phase", "Replicas", "Age"]);
    expect(cols.every((c) => c.sortable)).toBe(true);
  });

  test("namespace column drops out when every row shares one (namespace selected or cluster-scoped)", () => {
    const cols = crdTableColumns(PRINTER, { showNamespace: false });
    expect(cols.map((c) => c.key)).not.toContain("namespace");
  });

  test("printer column keys are unique even when two columns share a label", () => {
    const dup: CrdColumn[] = [
      { name: "Ready", json_path: ".status.ready", column_type: "string", description: "" },
      { name: "Ready", json_path: ".status.readyReplicas", column_type: "string", description: "" },
    ];
    const keys = crdTableColumns(dup, { showNamespace: false }).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("crdCellText", () => {
  const cols = crdTableColumns(PRINTER, { showNamespace: true });
  test("resolves printer columns through their JSONPath", () => {
    const r = res("a", { phase: "Ready", replicas: 3 });
    expect(crdCellText(r, cols[2].key, PRINTER)).toBe("Ready");
    expect(crdCellText(r, cols[3].key, PRINTER)).toBe("3");
  });
  test("unknown or empty values are the empty string", () => {
    expect(crdCellText(res("a"), cols[2].key, PRINTER)).toBe("");
    expect(crdCellText(res("a"), "crd:99", PRINTER)).toBe("");
  });
});

describe("filterCrdResources", () => {
  const items = [
    res("alpha", { ns: "prod", phase: "Ready" }),
    res("beta", { ns: "dev", phase: "Failed" }),
    res("gamma", { ns: "prod", phase: "Pending" }),
  ];

  test("empty text returns the same array", () => {
    expect(filterCrdResources(items, "", PRINTER)).toBe(items);
  });

  test("matches name and namespace case-insensitively", () => {
    expect(filterCrdResources(items, "ALP", PRINTER).map((r) => r.metadata.name)).toEqual(["alpha"]);
    expect(filterCrdResources(items, "prod", PRINTER).map((r) => r.metadata.name)).toEqual(["alpha", "gamma"]);
  });

  test("matches printer column values", () => {
    expect(filterCrdResources(items, "failed", PRINTER).map((r) => r.metadata.name)).toEqual(["beta"]);
  });
});

describe("sortCrdResources", () => {
  const cols = crdTableColumns(PRINTER, { showNamespace: true });
  const phaseKey = cols[2].key;
  const replicasKey = cols[3].key;
  const items = [
    res("b", { ns: "x", phase: "Ready", replicas: 10, created: "2026-01-02T00:00:00Z" }),
    res("a", { ns: "z", phase: "Failed", replicas: 2, created: "2026-01-03T00:00:00Z" }),
    res("c", { ns: "y", phase: "Pending", replicas: 1, created: "2026-01-01T00:00:00Z" }),
  ];
  const names = (rs: Resource[]) => rs.map((r) => r.metadata.name);

  test("does not mutate its input", () => {
    const copy = [...items];
    sortCrdResources(items, PRINTER, "name", "asc");
    expect(items).toEqual(copy);
  });

  test("by name, both directions", () => {
    expect(names(sortCrdResources(items, PRINTER, "name", "asc"))).toEqual(["a", "b", "c"]);
    expect(names(sortCrdResources(items, PRINTER, "name", "desc"))).toEqual(["c", "b", "a"]);
  });

  test("by namespace", () => {
    expect(names(sortCrdResources(items, PRINTER, "namespace", "asc"))).toEqual(["b", "c", "a"]);
  });

  test("by age: newest first when ascending, like built-in tables", () => {
    expect(names(sortCrdResources(items, PRINTER, "age", "asc"))).toEqual(["a", "b", "c"]);
  });

  test("by a string printer column", () => {
    expect(names(sortCrdResources(items, PRINTER, phaseKey, "asc"))).toEqual(["a", "c", "b"]);
  });

  test("by a numeric printer column compares numbers, not strings", () => {
    expect(names(sortCrdResources(items, PRINTER, replicasKey, "asc"))).toEqual(["c", "a", "b"]);
    expect(names(sortCrdResources(items, PRINTER, replicasKey, "desc"))).toEqual(["b", "a", "c"]);
  });

  test("an unknown sort column falls back to name", () => {
    expect(names(sortCrdResources(items, PRINTER, "podCpu", "asc"))).toEqual(["a", "b", "c"]);
  });
});

describe("moveRowIndex", () => {
  test("first press focuses the first row from either direction", () => {
    expect(moveRowIndex(-1, 1, 5)).toBe(0);
    expect(moveRowIndex(-1, -1, 5)).toBe(0);
  });
  test("moves and clamps at both ends", () => {
    expect(moveRowIndex(2, 1, 5)).toBe(3);
    expect(moveRowIndex(4, 1, 5)).toBe(4);
    expect(moveRowIndex(0, -1, 5)).toBe(0);
  });
  test("an index past a shrunken list clamps into range", () => {
    expect(moveRowIndex(9, -1, 5)).toBe(3);
  });
  test("no rows means no focus", () => {
    expect(moveRowIndex(3, 1, 0)).toBe(-1);
  });
});

describe("crdRowActions", () => {
  function deps() {
    return {
      open: mock((_r: Resource) => {}),
      copy: mock(async (_label: string, _produce: () => string | Promise<string>) => {}),
      fetchYaml: mock(async (r: Resource) => `kind: ${r.kind}`),
      remove: mock((_r: Resource) => {}),
    };
  }

  test("offers open, the copy actions and delete, delete last", () => {
    const ids = crdRowActions(res("a", { ns: "prod" }), deps()).map((a) => a.id);
    expect(ids).toEqual(["open", "copy-name", "copy-namespace", "copy-yaml", "copy-json", "delete"]);
  });

  test("a cluster-scoped object has no namespace to copy", () => {
    const ids = crdRowActions(res("a"), deps()).map((a) => a.id);
    expect(ids).not.toContain("copy-namespace");
  });

  test("each action routes to its dependency", async () => {
    const d = deps();
    const r = res("a", { ns: "prod", phase: "Ready" });
    const byId = Object.fromEntries(crdRowActions(r, d).map((a) => [a.id, a]));

    byId.open.execute();
    expect(d.open).toHaveBeenCalledWith(r);

    byId["copy-name"].execute();
    let [label, produce] = d.copy.mock.calls.at(-1)!;
    expect(label).toBe("Name");
    expect(await produce()).toBe("a");

    byId["copy-yaml"].execute();
    [label, produce] = d.copy.mock.calls.at(-1)!;
    expect(label).toBe("YAML");
    expect(await produce()).toBe("kind: Widget");
    expect(d.fetchYaml).toHaveBeenCalledWith(r);

    byId["copy-json"].execute();
    [, produce] = d.copy.mock.calls.at(-1)!;
    expect(JSON.parse(String(await produce())).metadata.name).toBe("a");

    byId.delete.execute();
    expect(d.remove).toHaveBeenCalledWith(r);
  });
});
