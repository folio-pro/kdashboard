// What a Service row and its detail need beyond the raw spec: where it is
// reachable from outside (and whether that address is still pending), its
// ports as "port→target/protocol", and — from EndpointSlices — how many
// backends it actually has. Pure.

import type { Resource } from "$lib/types";

type Json = Record<string, unknown>;

/** The label an EndpointSlice carries to name its Service. */
export const SERVICE_NAME_LABEL = "kubernetes.io/service-name";

export interface ServiceExternal {
  /** Addresses, comma-joined; empty when the service has none. */
  label: string;
  /** A LoadBalancer still waiting for the cloud to hand it an address. */
  pending: boolean;
}

/**
 * The External cell: load-balancer ingress (IP or hostname), then explicit
 * externalIPs, then an ExternalName target. A LoadBalancer with no ingress
 * yet is `pending`, which is the state worth showing in colour.
 */
export function serviceExternal(resource: Resource): ServiceExternal {
  const spec = (resource.spec ?? {}) as Json;
  const status = (resource.status ?? {}) as Json;
  const lb = status.loadBalancer as { ingress?: Array<{ ip?: string; hostname?: string }> } | undefined;
  const ingress = (lb?.ingress ?? []).map((e) => e.ip ?? e.hostname ?? "").filter(Boolean);
  const externalIPs = Array.isArray(spec.externalIPs) ? (spec.externalIPs as string[]) : [];
  const parts = [...ingress, ...externalIPs];
  if (typeof spec.externalName === "string" && spec.externalName) parts.push(spec.externalName);
  if (parts.length > 0) return { label: parts.join(", "), pending: false };
  return { label: "", pending: spec.type === "LoadBalancer" };
}

export interface ServicePort {
  name?: string;
  port?: number;
  targetPort?: string | number;
  protocol?: string;
  nodePort?: number;
  appProtocol?: string;
}

export function servicePorts(resource: Resource): ServicePort[] {
  const ports = (resource.spec as Json | undefined)?.ports;
  return Array.isArray(ports) ? (ports as ServicePort[]) : [];
}

/** `80→8080/TCP`, `443/TCP` when the target is the same, ` :30080` when a node port is open. */
export function servicePortLabel(p: ServicePort): string {
  const port = p.port ?? "";
  const target = p.targetPort;
  const differs = target !== undefined && target !== "" && String(target) !== String(port);
  let label = differs ? `${port}→${target}` : `${port}`;
  label += `/${p.protocol ?? "TCP"}`;
  if (p.nodePort) label += ` :${p.nodePort}`;
  return label;
}

/** Every port of the service, comma-joined — the Ports cell. */
export function servicePortsLabel(resource: Resource): string {
  return servicePorts(resource).map(servicePortLabel).join(", ");
}

/** A headless service: ClusterIP explicitly "None". */
export function isHeadless(resource: Resource): boolean {
  return (resource.spec as Json | undefined)?.clusterIP === "None";
}

/** The selector as `k=v` terms. */
export function serviceSelector(resource: Resource): string[] {
  const sel = (resource.spec as Json | undefined)?.selector;
  if (!sel || typeof sel !== "object") return [];
  return Object.entries(sel as Record<string, string>).map(([k, v]) => `${k}=${v}`);
}

// ---------------------------------------------------------------------------
// EndpointSlices
// ---------------------------------------------------------------------------

export interface EndpointSummary {
  /** Endpoints whose `ready` condition is not false. */
  ready: number;
  /** Every endpoint in the service's slices. */
  total: number;
  /** Endpoints that are terminating. */
  terminating: number;
}

export interface EndpointAddress {
  address: string;
  port?: number;
  ready: boolean;
  serving: boolean;
  terminating: boolean;
  targetRef?: { kind?: string; name?: string; namespace?: string };
  nodeName?: string;
  zone?: string;
}

interface SliceEndpoint {
  addresses?: string[];
  conditions?: { ready?: boolean; serving?: boolean; terminating?: boolean };
  targetRef?: { kind?: string; name?: string; namespace?: string };
  nodeName?: string;
  zone?: string;
}

/** The slices that belong to `serviceName` (by the service-name label), in `namespace` when given. */
export function slicesForService(slices: Resource[], serviceName: string, namespace?: string | null): Resource[] {
  return slices.filter(
    (s) =>
      s.metadata?.labels?.[SERVICE_NAME_LABEL] === serviceName &&
      (namespace == null || namespace === "" || s.metadata?.namespace === namespace),
  );
}

function sliceEndpoints(slice: Resource): SliceEndpoint[] {
  // The list projection copies `endpoints` into a synthetic spec; a full
  // object keeps it at the top level.
  const top = (slice as unknown as Json).endpoints;
  const list = Array.isArray(top) ? top : (slice.spec as Json | undefined)?.endpoints;
  return Array.isArray(list) ? (list as SliceEndpoint[]) : [];
}

/**
 * Ready / total over the service's slices. Null when the service has no
 * slice at all (ExternalName, or the controller has not written one yet) —
 * distinct from zero, which means "a slice exists and it is empty".
 */
export function endpointSummary(slices: Resource[], serviceName: string, namespace?: string | null): EndpointSummary | null {
  const mine = slicesForService(slices, serviceName, namespace);
  if (mine.length === 0) return null;
  // One endpoint is one backend: `addresses` is an array for historical
  // reasons, the controller writes exactly one and kube-proxy reads only the
  // first — so count endpoints, not addresses.
  let ready = 0, total = 0, terminating = 0;
  for (const slice of mine) {
    for (const ep of sliceEndpoints(slice)) {
      if (!ep.addresses?.length) continue;
      total += 1;
      if (ep.conditions?.ready !== false) ready += 1;
      if (ep.conditions?.terminating === true) terminating += 1;
    }
  }
  return { ready, total, terminating };
}

/** One row per endpoint (its first address) across the service's slices, with the slice's first port. */
export function endpointAddresses(slices: Resource[], serviceName: string, namespace?: string | null): EndpointAddress[] {
  const out: EndpointAddress[] = [];
  for (const slice of slicesForService(slices, serviceName, namespace)) {
    const topPorts = (slice as unknown as Json).ports;
    const ports = (Array.isArray(topPorts) ? topPorts : (slice.spec as Json | undefined)?.ports) as Array<{ port?: number }> | undefined;
    const port = ports?.[0]?.port;
    for (const ep of sliceEndpoints(slice)) {
      const address = ep.addresses?.[0];
      if (!address) continue;
      out.push({
        address,
        port,
        ready: ep.conditions?.ready !== false,
        serving: ep.conditions?.serving !== false,
        terminating: ep.conditions?.terminating === true,
        targetRef: ep.targetRef,
        nodeName: ep.nodeName,
        zone: ep.zone,
      });
    }
  }
  return out;
}
