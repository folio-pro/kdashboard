// Pure derivations for ServiceDetails: which Ingresses route to the service,
// which controllers stand behind the pods its selector matches, and which
// matched pods are not in any EndpointSlice yet. Testable under bun.

import type { Resource } from "$lib/types";
import { podOwner } from "$lib/utils/pod-status";
import type { EndpointAddress } from "$lib/utils/service-info";

type Json = Record<string, unknown>;

export interface IngressRoute {
  /** The Ingress name. */
  name: string;
  /** `host` + `path` pairs that point at this service, joined for display. */
  routes: string[];
}

/**
 * The Ingresses whose rules (or default backend) send traffic to `serviceName`,
 * with a short "host path" note per matching path.
 */
export function ingressesForService(ingresses: Resource[], serviceName: string, namespace?: string | null): IngressRoute[] {
  const out: IngressRoute[] = [];
  for (const ing of ingresses) {
    // Ingress backends resolve in the Ingress's own namespace.
    if (namespace != null && namespace !== "" && ing.metadata.namespace !== namespace) continue;
    const spec = (ing.spec ?? {}) as Json;
    const routes: string[] = [];
    const defaultBackend = spec.defaultBackend as { service?: { name?: string } } | undefined;
    if (defaultBackend?.service?.name === serviceName) routes.push("default backend");
    const rules = Array.isArray(spec.rules) ? (spec.rules as Array<Json>) : [];
    for (const rule of rules) {
      const host = typeof rule.host === "string" ? rule.host : "*";
      const http = rule.http as { paths?: Array<{ path?: string; backend?: { service?: { name?: string } } }> } | undefined;
      for (const p of http?.paths ?? []) {
        if (p.backend?.service?.name === serviceName) routes.push(`${host} ${p.path ?? "/"}`.trim());
      }
    }
    if (routes.length > 0) out.push({ name: ing.metadata.name, routes });
  }
  return out;
}

export interface OwnerRef {
  kind: string;
  name: string;
}

/** Distinct controllers (ReplicaSet, StatefulSet…) behind the matched pods, in first-seen order. */
export function podControllers(pods: Resource[]): OwnerRef[] {
  const seen = new Set<string>();
  const out: OwnerRef[] = [];
  for (const pod of pods) {
    const owner = podOwner(pod);
    if (!owner) continue;
    const key = `${owner.kind}/${owner.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: owner.kind, name: owner.name });
  }
  return out;
}

/** Pods the selector matches that no EndpointSlice lists yet (not ready, or not yet reconciled). */
export function podsMissingFromSlices(pods: Resource[], addresses: EndpointAddress[]): Resource[] {
  const listed = new Set(addresses.map((a) => a.targetRef?.name).filter((n): n is string => Boolean(n)));
  return pods.filter((p) => !listed.has(p.metadata.name));
}

/** Distinct EndpointSlice names + address types for the footer line. */
export function sliceSummaryLine(slices: Resource[]): string {
  if (slices.length === 0) return "";
  const names = slices.map((s) => s.metadata.name);
  const types = [...new Set(slices.map((s) => ((s.spec as Json | undefined)?.addressType as string) ?? (s as unknown as Json).addressType as string).filter(Boolean))];
  return [`EndpointSlice ${names.join(", ")}`, ...types].join(" · ");
}
