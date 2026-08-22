import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { ingressesForService, podControllers, podsMissingFromSlices, sliceSummaryLine } from "./service-details.logic";

function res(name: string, spec: Record<string, unknown> = {}, owners: Array<{ kind: string; name: string }> = []): Resource {
  return {
    kind: "X",
    api_version: "v1",
    metadata: {
      name, namespace: "ns", uid: name, creation_timestamp: "", labels: {}, annotations: {}, resource_version: "1",
      owner_references: owners.map((o) => ({ api_version: "apps/v1", uid: "o", controller: true, ...o })),
    },
    spec,
    status: {},
  };
}

describe("ingressesForService", () => {
  test("matches rule paths and the default backend, with host + path notes", () => {
    const ingresses = [
      res("shop-public", {
        rules: [
          { host: "shop.example.com", http: { paths: [{ path: "/", backend: { service: { name: "web" } } }, { path: "/api", backend: { service: { name: "api" } } }] } },
          { http: { paths: [{ backend: { service: { name: "web" } } }] } },
        ],
      }),
      res("fallback", { defaultBackend: { service: { name: "web" } } }),
      res("other", { rules: [{ host: "x", http: { paths: [{ path: "/", backend: { service: { name: "api" } } }] } }] }),
    ];
    expect(ingressesForService(ingresses, "web")).toEqual([
      { name: "shop-public", routes: ["shop.example.com /", "* /"] },
      { name: "fallback", routes: ["default backend"] },
    ]);
    expect(ingressesForService(ingresses, "nothing")).toEqual([]);
    // Scoped to a namespace, an Ingress from another namespace does not count.
    expect(ingressesForService(ingresses, "web", "ns")).toHaveLength(2);
    expect(ingressesForService(ingresses, "web", "elsewhere")).toEqual([]);
  });
});

describe("podControllers / podsMissingFromSlices", () => {
  test("dedupes controllers in first-seen order", () => {
    const pods = [
      res("a", {}, [{ kind: "ReplicaSet", name: "web-1" }]),
      res("b", {}, [{ kind: "ReplicaSet", name: "web-1" }]),
      res("c", {}, [{ kind: "StatefulSet", name: "db" }]),
      res("d"),
    ];
    expect(podControllers(pods)).toEqual([{ kind: "ReplicaSet", name: "web-1" }, { kind: "StatefulSet", name: "db" }]);
  });

  test("pods not listed by any endpoint address", () => {
    const pods = [res("a"), res("b"), res("c")];
    const addresses = [
      { address: "1", ready: true, serving: true, terminating: false, targetRef: { kind: "Pod", name: "a" } },
      { address: "2", ready: false, serving: false, terminating: false },
    ];
    expect(podsMissingFromSlices(pods, addresses).map((p) => p.metadata.name)).toEqual(["b", "c"]);
  });

  test("slice summary line", () => {
    expect(sliceSummaryLine([])).toBe("");
    expect(sliceSummaryLine([res("web-9xk2m", { addressType: "IPv4" }), res("web-abc", { addressType: "IPv4" })])).toBe("EndpointSlice web-9xk2m, web-abc · IPv4");
  });
});
