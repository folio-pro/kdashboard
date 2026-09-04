import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import {
  MIN_SEARCH_LENGTH,
  ResourceSearchIndex,
  parseSearchQuery,
  resolveKindFilter,
  scoreName,
} from "./resource-search.logic";

function res(kind: string, name: string, namespace?: string): Resource {
  return {
    kind,
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid: `${kind}-${namespace ?? ""}-${name}`,
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: {},
  };
}

describe("parseSearchQuery", () => {
  test("splits free text into lowercase terms", () => {
    expect(parseSearchQuery("  Payments API ")).toEqual({ terms: ["payments", "api"] });
  });

  test("lifts ns: and kind: filters out of the terms", () => {
    expect(parseSearchQuery("ns:Billing kind:deploy payments")).toEqual({
      terms: ["payments"],
      namespace: "billing",
      resourceType: "deployments",
    });
  });

  test("accepts namespace:, k: and type: spellings", () => {
    expect(parseSearchQuery("namespace:a k:Pod").namespace).toBe("a");
    expect(parseSearchQuery("namespace:a k:Pod").resourceType).toBe("pods");
    expect(parseSearchQuery("type:svc").resourceType).toBe("services");
  });

  test("an unknown kind keeps a sentinel so nothing matches instead of everything", () => {
    expect(parseSearchQuery("kind:widget foo").resourceType).toBe("unknown:widget");
  });

  test("a bare colon-less word with a colon inside is still a term", () => {
    expect(parseSearchQuery("a:b")).toEqual({ terms: ["a:b"] });
  });
});

describe("resolveKindFilter", () => {
  test("resolves type, short name and Kind in either case", () => {
    expect(resolveKindFilter("deployments")).toBe("deployments");
    expect(resolveKindFilter("deploy")).toBe("deployments");
    expect(resolveKindFilter("Deployment")).toBe("deployments");
    expect(resolveKindFilter("STS")).toBe("statefulsets");
    expect(resolveKindFilter("nope")).toBeUndefined();
  });
});

describe("scoreName", () => {
  test("exact beats prefix beats segment beats substring", () => {
    const exact = scoreName("api", ["api"]);
    const prefix = scoreName("api-gateway", ["api"]);
    const segment = scoreName("payments-api", ["api"]);
    const substring = scoreName("rapid", ["api"]);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(segment);
    expect(segment).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
  });

  test("every term must match", () => {
    expect(scoreName("payments-api", ["payments", "api"])).toBeGreaterThan(0);
    expect(scoreName("payments-api", ["payments", "worker"])).toBe(0);
    expect(scoreName("payments-api", [])).toBe(0);
  });

  test("shorter matching names rank above longer ones of the same class", () => {
    expect(scoreName("payments-api", ["payments"])).toBeGreaterThan(
      scoreName("payments-api-7f9c8d-x2k", ["payments"]),
    );
  });
});

describe("ResourceSearchIndex", () => {
  const cluster: Record<string, Resource[]> = {
    deployments: [res("Deployment", "payments-api", "billing"), res("Deployment", "checkout", "shop")],
    pods: [
      res("Pod", "payments-api-7f9c-x2k", "billing"),
      res("Pod", "payments-api-7f9c-m1q", "billing"),
      res("Pod", "checkout-5d8-a1c", "shop"),
    ],
    services: [res("Service", "payments-api", "billing")],
    nodes: [res("Node", "ip-10-0-1-12")],
  };
  const TYPES = ["deployments", "pods", "services", "nodes"];

  function clusterWideList() {
    const calls: Array<[string, string | undefined]> = [];
    const listFn = async (type: string, ns?: string) => {
      calls.push([type, ns]);
      const all = cluster[type] ?? [];
      return ns ? all.filter((r) => r.metadata.namespace === ns) : all;
    };
    return { listFn, calls };
  }

  test("lists each type once cluster-wide and ranks hits across kinds", async () => {
    const { listFn, calls } = clusterWideList();
    const index = new ResourceSearchIndex(listFn, { types: TYPES, now: () => 1000 });
    await index.ensureLoaded(["billing", "shop"]);
    expect(calls).toEqual([
      ["deployments", ""],
      ["pods", ""],
      ["services", ""],
      ["nodes", undefined],
    ]);
    const hits = index.search("payments");
    expect(hits.map((h) => `${h.resourceType}/${h.resource.metadata.name}`)).toEqual([
      "deployments/payments-api",
      "services/payments-api",
      "pods/payments-api-7f9c-m1q",
      "pods/payments-api-7f9c-x2k",
    ]);
  });

  test("falls back to per-namespace listing when cluster scope is forbidden, and remembers it", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const listFn = async (type: string, ns?: string) => {
      calls.push([type, ns]);
      if (ns === "") throw new Error("pods is forbidden: cannot list at the cluster scope");
      const all = cluster[type] ?? [];
      return ns ? all.filter((r) => r.metadata.namespace === ns) : all;
    };
    const index = new ResourceSearchIndex(listFn, { types: ["pods"], now: () => 1000 });
    await index.ensureLoaded(["billing", "shop"]);
    expect(calls).toEqual([["pods", ""], ["pods", "billing"], ["pods", "shop"]]);
    expect(index.search("checkout")).toHaveLength(1);
    expect(index.clusterScopeRefused.has("pods")).toBe(true);

    // Second load after TTL: skips the cluster-wide call outright.
    calls.length = 0;
    const later = new ResourceSearchIndex(listFn, { types: ["pods"], now: () => 1000 });
    later.clusterScopeRefused.add("pods");
    await later.ensureLoaded(["billing"]);
    expect(calls).toEqual([["pods", "billing"]]);
  });

  test("a kind that cannot be listed anywhere records an error and yields no hits", async () => {
    const listFn = async () => {
      throw new Error("secrets is forbidden");
    };
    const index = new ResourceSearchIndex(listFn, { types: ["secrets"] });
    await index.ensureLoaded(["a", "b"]);
    expect(index.errors.get("secrets")).toContain("Cannot list secrets");
    expect(index.search("anything")).toEqual([]);
    expect(index.ready).toBe(true);
  });

  test("respects the TTL: fresh types are not re-listed, stale ones are", async () => {
    let now = 1000;
    const { listFn, calls } = clusterWideList();
    const index = new ResourceSearchIndex(listFn, { types: ["nodes"], ttlMs: 500, now: () => now });
    await index.ensureLoaded([]);
    await index.ensureLoaded([]);
    expect(calls).toHaveLength(1);
    now += 600;
    await index.ensureLoaded([]);
    expect(calls).toHaveLength(2);
  });

  test("concurrent loads of the same type share one request", async () => {
    const { listFn, calls } = clusterWideList();
    const index = new ResourceSearchIndex(listFn, { types: ["nodes"] });
    await Promise.all([index.ensureLoaded([]), index.ensureLoaded([])]);
    expect(calls).toHaveLength(1);
  });

  test("ns: and kind: filters narrow the hits; filters alone list the scope", async () => {
    const { listFn } = clusterWideList();
    const index = new ResourceSearchIndex(listFn, { types: TYPES });
    await index.ensureLoaded([]);
    expect(index.search("payments ns:shop")).toEqual([]);
    expect(index.search("payments kind:svc").map((h) => h.resourceType)).toEqual(["services"]);
    expect(index.search("ns:shop").map((h) => h.resource.metadata.name).sort()).toEqual([
      "checkout",
      "checkout-5d8-a1c",
    ]);
    expect(index.search("kind:widget")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
  });

  test("invalidate drops the cache", async () => {
    const { listFn, calls } = clusterWideList();
    const index = new ResourceSearchIndex(listFn, { types: ["nodes"] });
    await index.ensureLoaded([]);
    index.invalidate();
    expect(index.search("ip-10")).toEqual([]);
    await index.ensureLoaded([]);
    expect(calls).toHaveLength(2);
  });

  test("MIN_SEARCH_LENGTH is two characters", () => {
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });
});

describe("ResourceSearchIndex — active namespace boost", () => {
  const items: Record<string, Resource[]> = {
    deployments: [
      res("Deployment", "web-api", "shop-staging"),
      res("Deployment", "web-api", "shop"),
      res("Deployment", "web-api", "billing"),
    ],
    pods: [res("Pod", "web-api-7f9c-x2k", "shop-staging"), res("Pod", "web-api-7f9c-m1q", "shop")],
  };
  const listFn = async (type: string) => items[type] ?? [];

  async function loaded() {
    const index = new ResourceSearchIndex(listFn, { types: ["deployments", "pods"] });
    await index.ensureLoaded([]);
    return index;
  }

  test("equal-score hits from the active namespace come first, kind order otherwise intact", async () => {
    const index = await loaded();
    const key = (h: { resourceType: string; resource: Resource }) => `${h.resourceType}/${h.resource.metadata.namespace}/${h.resource.metadata.name}`;
    expect(index.search("web-api", 30, "shop").map(key)).toEqual([
      "deployments/shop/web-api",
      "deployments/shop-staging/web-api",
      "deployments/billing/web-api",
      "pods/shop/web-api-7f9c-m1q",
      "pods/shop-staging/web-api-7f9c-x2k",
    ]);
  });

  test("a better score still beats the active namespace", async () => {
    const index = await loaded();
    // Exact match in shop-staging outranks a prefix match in shop.
    const hits = index.search("web-api-7f9c-x2k", 30, "shop");
    expect(hits[0].resource.metadata.namespace).toBe("shop-staging");
  });

  test("without a preferred namespace equal hits keep list order", async () => {
    const index = await loaded();
    const names = index.search("web-api").map((h) => h.resource.metadata.namespace);
    expect(names.slice(0, 3)).toEqual(["shop-staging", "shop", "billing"]);
  });
});
