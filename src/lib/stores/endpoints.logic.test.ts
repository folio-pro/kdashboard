import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { SERVICE_NAME_LABEL } from "$lib/utils/service-info";
import { ENDPOINTS_TTL_MS, EndpointsStoreLogic } from "./endpoints.logic";

function slice(service: string, namespace: string, addresses: string[], ready = true): Resource {
  return {
    kind: "EndpointSlice",
    api_version: "discovery.k8s.io/v1",
    metadata: { name: `${service}-x`, namespace, uid: "u", creation_timestamp: "", labels: { [SERVICE_NAME_LABEL]: service }, annotations: {}, resource_version: "1", owner_references: [] },
    // One endpoint per address: that is how the controller writes slices.
    spec: { endpoints: addresses.map((a) => ({ addresses: [a], conditions: { ready } })) },
    status: {},
  };
}

describe("EndpointsStoreLogic", () => {
  test("undefined before a load, null for a service without slices, counts otherwise", () => {
    const s = new EndpointsStoreLogic();
    expect(s.summaryFor("ns", "web")).toBeUndefined();
    s.apply([slice("web", "ns", ["10.0.0.1", "10.0.0.2"]), slice("web", "ns", ["10.0.0.3"], false)], "ns", 1000);
    expect(s.summaryFor("ns", "web")).toEqual({ ready: 2, total: 3, terminating: 0 });
    expect(s.summaryFor("ns", "other")).toBeNull();
    expect(s.slicesFor("ns", "web")).toHaveLength(2);
  });

  test("a namespace load does not answer for another namespace; an all-namespaces load does", () => {
    const s = new EndpointsStoreLogic();
    s.apply([slice("web", "a", ["1"])], "a", 1000);
    expect(s.summaryFor("b", "web")).toBeUndefined();
    s.apply([slice("web", "a", ["1"]), slice("web", "b", ["2", "3"])], null, 2000);
    expect(s.summaryFor("a", "web")?.total).toBe(1);
    expect(s.summaryFor("b", "web")?.total).toBe(2);
  });

  test("staleness: never loaded, other namespace, or past the TTL", () => {
    const s = new EndpointsStoreLogic();
    expect(s.isStale(0, "a")).toBe(true);
    s.apply([], "a", 1000);
    expect(s.isStale(1000 + ENDPOINTS_TTL_MS - 1, "a")).toBe(false);
    expect(s.isStale(1000 + ENDPOINTS_TTL_MS, "a")).toBe(true);
    expect(s.isStale(1001, "b")).toBe(true);
  });

  test("reset forgets everything and invalidates in-flight loads", () => {
    const s = new EndpointsStoreLogic();
    s.apply([slice("web", "a", ["1"])], "a", 1000);
    const id = s._requestId;
    s.reset();
    expect(s.summaryFor("a", "web")).toBeUndefined();
    expect(s._requestId).toBe(id + 1);
  });
});
