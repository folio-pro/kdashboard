import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import {
  endpointAddresses,
  endpointSummary,
  isHeadless,
  serviceExternal,
  servicePortLabel,
  servicePortsLabel,
  serviceSelector,
  SERVICE_NAME_LABEL,
} from "./service-info";

function svc(spec: Record<string, unknown>, status: Record<string, unknown> = {}): Resource {
  return {
    kind: "Service",
    api_version: "v1",
    metadata: { name: "svc", namespace: "ns", uid: "u", creation_timestamp: "", labels: {}, annotations: {}, resource_version: "1", owner_references: [] },
    spec,
    status,
  };
}

function slice(service: string, endpoints: unknown[], namespace = "ns", ports: unknown[] = [{ port: 8080 }]): Resource {
  return {
    kind: "EndpointSlice",
    api_version: "discovery.k8s.io/v1",
    metadata: { name: `${service}-abc`, namespace, uid: "u", creation_timestamp: "", labels: { [SERVICE_NAME_LABEL]: service }, annotations: {}, resource_version: "1", owner_references: [] },
    spec: { addressType: "IPv4", endpoints, ports },
    status: {},
  };
}

describe("serviceExternal", () => {
  test("load balancer ingress, ip or hostname", () => {
    expect(serviceExternal(svc({ type: "LoadBalancer" }, { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } }))).toEqual({ label: "1.2.3.4", pending: false });
    expect(serviceExternal(svc({ type: "LoadBalancer" }, { loadBalancer: { ingress: [{ hostname: "a.elb.amazonaws.com" }] } }))).toEqual({ label: "a.elb.amazonaws.com", pending: false });
  });

  test("a LoadBalancer without an address is pending; a ClusterIP simply has none", () => {
    expect(serviceExternal(svc({ type: "LoadBalancer" }))).toEqual({ label: "", pending: true });
    expect(serviceExternal(svc({ type: "ClusterIP" }))).toEqual({ label: "", pending: false });
  });

  test("externalIPs and ExternalName", () => {
    expect(serviceExternal(svc({ type: "ClusterIP", externalIPs: ["10.0.0.1"] })).label).toBe("10.0.0.1");
    expect(serviceExternal(svc({ type: "ExternalName", externalName: "db.internal" })).label).toBe("db.internal");
  });
});

describe("ports", () => {
  test("port→target/protocol, collapsing an identical target, with node port", () => {
    expect(servicePortLabel({ port: 80, targetPort: 8080 })).toBe("80→8080/TCP");
    expect(servicePortLabel({ port: 443, targetPort: 443, protocol: "TCP" })).toBe("443/TCP");
    expect(servicePortLabel({ port: 80, targetPort: "http", protocol: "UDP" })).toBe("80→http/UDP");
    expect(servicePortLabel({ port: 9090, nodePort: 30090 })).toBe("9090/TCP :30090");
    expect(servicePortsLabel(svc({ ports: [{ port: 80, targetPort: 8080 }, { port: 443, targetPort: 8443 }] }))).toBe("80→8080/TCP, 443→8443/TCP");
    expect(servicePortsLabel(svc({}))).toBe("");
  });

  test("headless and selector", () => {
    expect(isHeadless(svc({ clusterIP: "None" }))).toBe(true);
    expect(isHeadless(svc({ clusterIP: "10.0.0.1" }))).toBe(false);
    expect(serviceSelector(svc({ selector: { app: "web", tier: "fe" } }))).toEqual(["app=web", "tier=fe"]);
    expect(serviceSelector(svc({}))).toEqual([]);
  });
});

describe("endpointSummary / endpointAddresses", () => {
  const slices = [
    slice("web", [
      { addresses: ["10.0.0.1"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "web-1" }, nodeName: "n1", zone: "a" },
      { addresses: ["10.0.0.2", "10.0.0.3"], conditions: { ready: false, serving: false }, targetRef: { kind: "Pod", name: "web-2" } },
      { addresses: ["10.0.0.4"], conditions: { ready: false, terminating: true } },
    ]),
    slice("web", [{ addresses: ["10.0.1.1"] }]),
    slice("other", [{ addresses: ["10.0.9.9"] }]),
    slice("web", [{ addresses: ["10.1.0.1"] }], "elsewhere"),
  ];

  test("counts only the service's slices in the namespace", () => {
    expect(endpointSummary(slices, "web", "ns")).toEqual({ ready: 2, total: 5, terminating: 1 });
    expect(endpointSummary(slices, "web")).toEqual({ ready: 3, total: 6, terminating: 1 });
  });

  test("null when no slice exists, zero when the slice is empty", () => {
    expect(endpointSummary(slices, "missing", "ns")).toBeNull();
    expect(endpointSummary([slice("empty", [])], "empty", "ns")).toEqual({ ready: 0, total: 0, terminating: 0 });
  });

  test("addresses flatten with the slice port and endpoint metadata", () => {
    const rows = endpointAddresses(slices, "web", "ns");
    expect(rows.map((r) => r.address)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.1.1"]);
    expect(rows[0]).toEqual({ address: "10.0.0.1", port: 8080, ready: true, serving: true, terminating: false, targetRef: { kind: "Pod", name: "web-1" }, nodeName: "n1", zone: "a" });
    expect(rows[1].ready).toBe(false);
    expect(rows[3].terminating).toBe(true);
  });

  test("reads a full EndpointSlice object (endpoints at the top level) too", () => {
    const full = { ...slice("web", []), endpoints: [{ addresses: ["10.2.0.1"] }], ports: [{ port: 80 }] } as unknown as Resource;
    expect(endpointSummary([full], "web", "ns")).toEqual({ ready: 1, total: 1, terminating: 0 });
    expect(endpointAddresses([full], "web", "ns")[0].port).toBe(80);
  });
});
