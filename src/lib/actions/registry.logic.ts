import type { Resource } from "$lib/types";

export const SCALABLE_TYPES = ["deployments", "statefulsets", "replicasets"];
export const RESTARTABLE_TYPES = ["deployments", "statefulsets", "daemonsets"];
export const LOG_TYPES = ["pods", "deployments"];

export const GROUP_ORDER: Record<string, number> = {
  smart: 0,
  navigate: 1,
  operations: 2,
  clipboard: 3,
  destructive: 4,
};

/** Group items by a `group` field and sort by GROUP_ORDER */
export function groupActions<T extends { group: string }>(actions: T[]): Array<{ group: string; actions: T[] }> {
  const groups = new Map<string, T[]>();
  for (const action of actions) {
    const existing = groups.get(action.group);
    if (existing) existing.push(action);
    else groups.set(action.group, [action]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (GROUP_ORDER[a] ?? 99) - (GROUP_ORDER[b] ?? 99))
    .map(([group, actions]) => ({ group, actions }));
}

export interface PortForwardInfo {
  namespace: string;
  local_port: number;
}

/** Extract a browseable URL from a Service or Ingress resource.
 *  Optionally pass active port-forwards for fallback Service URLs. */
export function getResourceUrl(resource: Resource, portForwards?: PortForwardInfo[]): string | null {
  if (resource.kind === "Service") {
    const lb = resource.status?.loadBalancer as Record<string, unknown> | undefined;
    const ingress = lb?.ingress as Array<{ ip?: string; hostname?: string }> | undefined;
    if (ingress && ingress.length > 0) {
      const host = ingress[0].hostname ?? ingress[0].ip ?? "";
      const ports = resource.spec?.ports as Array<{ port: number }> | undefined;
      const port = ports?.[0]?.port;
      return port && port !== 80 && port !== 443
        ? `http://${host}:${port}`
        : `http://${host}`;
    }
    if (portForwards) {
      const pf = portForwards.find(
        (pf) => pf.namespace === resource.metadata.namespace,
      );
      return pf ? `http://localhost:${pf.local_port}` : null;
    }
    return null;
  }
  if (resource.kind === "Ingress") {
    const rules = resource.spec?.rules as Array<{ host?: string }> | undefined;
    const host = rules?.[0]?.host;
    if (!host) return null;
    const tls = resource.spec?.tls as Array<unknown> | undefined;
    return tls && tls.length > 0 ? `https://${host}` : `http://${host}`;
  }
  return null;
}
