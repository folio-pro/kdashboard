import { describe, expect, test } from "bun:test";
import type { Column, Resource } from "$lib/types";
import {
  parseFacet,
  facetToText,
  resolveFacetKey,
  extractFacets,
  matchesFacet,
  applyFacets,
  sameFacets,
  splitPodName,
} from "./table-filter";

const columns: Column[] = [
  { key: "name", label: "Name", sortable: true },
  { key: "namespace", label: "Namespace", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "restarts", label: "Restarts", sortable: true },
  { key: "node", label: "Node", sortable: true },
  { key: "cjLastSchedule", label: "Last Schedule", sortable: false },
];

function pod(name: string, phase: string, restarts: number, extra: Record<string, unknown> = {}): Resource {
  return {
    kind: "Pod",
    metadata: { name, namespace: "default", uid: name, creation_timestamp: "2024-01-01T00:00:00Z" },
    spec: { nodeName: "ip-10-0-1-1" },
    status: { phase, containerStatuses: [{ name: "c", ready: true, restartCount: restarts, image: "x" }] },
    ...extra,
  } as unknown as Resource;
}

const ctx = { ageTick: 0 };
const ctxFor = () => ctx;

describe("parseFacet", () => {
  test("key:value", () => {
    expect(parseFacet("status:running")).toEqual({ key: "status", op: ":", value: "running" });
  });
  test("negation", () => {
    expect(parseFacet("status:!running")).toEqual({ key: "status", op: "!:", value: "running" });
  });
  test("numeric comparisons", () => {
    expect(parseFacet("restarts:>0")).toEqual({ key: "restarts", op: ">", value: "0" });
    expect(parseFacet("restarts:>=5")).toEqual({ key: "restarts", op: ">=", value: "5" });
    expect(parseFacet("restarts:<2")).toEqual({ key: "restarts", op: "<", value: "2" });
    expect(parseFacet("restarts:<=2")).toEqual({ key: "restarts", op: "<=", value: "2" });
  });
  test("plain text is not a facet", () => {
    expect(parseFacet("api")).toBeNull();
    expect(parseFacet("status:")).toBeNull();
    expect(parseFacet(":running")).toBeNull();
  });
  test("a URL parses as a term but its key never resolves, so it stays text", () => {
    expect(extractFacets("http://x", columns)).toEqual({ facets: [], text: "http://x" });
  });
  test("round-trips through facetToText", () => {
    for (const t of ["status:running", "status:!running", "restarts:>0", "restarts:<=2"]) {
      expect(facetToText(parseFacet(t)!)).toBe(t);
    }
  });
});

describe("resolveFacetKey", () => {
  test("matches column key and label, case-insensitively", () => {
    expect(resolveFacetKey("Status", columns)).toBe("status");
    expect(resolveFacetKey("lastschedule", columns)).toBe("cjLastSchedule");
    expect(resolveFacetKey("last-schedule", columns)).toBe("cjLastSchedule");
  });
  test("aliases", () => {
    expect(resolveFacetKey("ns", columns)).toBe("namespace");
    expect(resolveFacetKey("state", columns)).toBe("status");
    expect(resolveFacetKey("rst", columns)).toBe("restarts");
  });
  test("unknown key stays text", () => {
    expect(resolveFacetKey("foo", columns)).toBeNull();
  });
  test("restarts and status resolve even when not a column", () => {
    expect(resolveFacetKey("restarts", [])).toBe("restarts");
    expect(resolveFacetKey("status", [])).toBe("status");
  });
});

describe("extractFacets", () => {
  test("lifts resolvable terms, keeps the rest as text", () => {
    const r = extractFacets("api status:!running foo:bar restarts:>0", columns);
    expect(r.facets).toEqual([
      { key: "status", op: "!:", value: "running" },
      { key: "restarts", op: ">", value: "0" },
    ]);
    expect(r.text).toBe("api foo:bar");
  });
  test("empty input", () => {
    expect(extractFacets("", columns)).toEqual({ facets: [], text: "" });
  });
});

describe("matchesFacet / applyFacets", () => {
  const items = [
    pod("api-1", "Running", 0),
    pod("api-2", "CrashLoopBackOff", 14),
    pod("job-1", "Succeeded", 0),
  ];

  test("substring, case-insensitive", () => {
    expect(matchesFacet(items[0], { key: "status", op: ":", value: "run" }, ctx)).toBe(true);
    expect(matchesFacet(items[1], { key: "status", op: ":", value: "run" }, ctx)).toBe(false);
  });
  test("negation", () => {
    const out = applyFacets(items, [{ key: "status", op: "!:", value: "running" }], ctxFor);
    expect(out.map((r) => r.metadata.name)).toEqual(["api-2", "job-1"]);
  });
  test("numeric", () => {
    expect(applyFacets(items, [{ key: "restarts", op: ">", value: "0" }], ctxFor).map((r) => r.metadata.name)).toEqual(["api-2"]);
    expect(applyFacets(items, [{ key: "restarts", op: "<=", value: "0" }], ctxFor).length).toBe(2);
  });
  test("numeric op on a non-numeric cell never matches", () => {
    expect(matchesFacet(items[0], { key: "status", op: ">", value: "1" }, ctx)).toBe(false);
  });
  test("all facets must match", () => {
    const out = applyFacets(items, [
      { key: "status", op: "!:", value: "running" },
      { key: "restarts", op: ">", value: "0" },
    ], ctxFor);
    expect(out.map((r) => r.metadata.name)).toEqual(["api-2"]);
  });
  test("no facets returns the same array", () => {
    expect(applyFacets(items, [], ctxFor)).toBe(items);
  });
});

describe("sameFacets", () => {
  test("order-insensitive equality", () => {
    const a = [{ key: "a", op: ":" as const, value: "1" }, { key: "b", op: ">" as const, value: "2" }];
    const b = [a[1], a[0]];
    expect(sameFacets(a, b)).toBe(true);
    expect(sameFacets(a, [a[0]])).toBe(false);
    expect(sameFacets(a, [a[0], { key: "b", op: "<", value: "2" }])).toBe(false);
  });
});

describe("splitPodName", () => {
  test("deployment pod: rs hash + pod suffix", () => {
    expect(splitPodName("api-gateway-7d4f8b9c5-2xkqp")).toEqual({ base: "api-gateway", suffix: "-7d4f8b9c5-2xkqp" });
    expect(splitPodName("nginx-deployment-66b6c48dd5-x7k2q")).toEqual({ base: "nginx-deployment", suffix: "-66b6c48dd5-x7k2q" });
  });
  test("daemonset / job pod: pod suffix only", () => {
    expect(splitPodName("metrics-agent-9k2ld")).toEqual({ base: "metrics-agent", suffix: "-9k2ld" });
  });
  test("cronjob pod: numeric job suffix + pod suffix", () => {
    expect(splitPodName("inventory-sync-29081-lq4rd")).toEqual({ base: "inventory-sync", suffix: "-29081-lq4rd" });
  });
  test("statefulset ordinal and hand-named pods are left whole", () => {
    expect(splitPodName("redis-cache-0")).toEqual({ base: "redis-cache-0", suffix: "" });
    expect(splitPodName("my-app-prod")).toEqual({ base: "my-app-prod", suffix: "" });
    expect(splitPodName("debug")).toEqual({ base: "debug", suffix: "" });
  });
  test("a bare 5-char random name keeps its base", () => {
    expect(splitPodName("x9k2d")).toEqual({ base: "x9k2d", suffix: "" });
  });
});
