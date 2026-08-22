// EndpointSlices for the Services table and detail: which backends each
// service really has. Loaded per namespace, indexed by service, refreshed on
// a TTL like pod metrics. The `.svelte.ts` subclass adds the IPC and $state.

import type { Resource } from "$lib/types";
import { endpointSummary, SERVICE_NAME_LABEL, type EndpointSummary } from "$lib/utils/service-info";

/** How long a loaded set of slices is trusted before the next table poll refreshes it. */
export const ENDPOINTS_TTL_MS = 15_000;

export function serviceKey(namespace: string | undefined | null, name: string): string {
  return `${namespace ?? ""}/${name}`;
}

export class EndpointsStoreLogic {
  /** Slices grouped by `${namespace}/${service}`. */
  byService: Record<string, Resource[]> = {};
  /** The namespace the slices were loaded for; null = all namespaces. */
  loadedNamespace: string | null | undefined = undefined;
  _loading = false;
  _fetchedAt = 0;
  _requestId = 0;

  /**
   * Ready/total for a service. `undefined` while nothing has been loaded for
   * its namespace (the cell shows nothing rather than a misleading 0); null
   * when loaded and the service has no slice.
   */
  summaryFor(namespace: string | undefined | null, name: string): EndpointSummary | null | undefined {
    if (!this.covers(namespace)) return undefined;
    const slices = this.byService[serviceKey(namespace, name)];
    if (!slices) return null;
    return endpointSummary(slices, name, namespace);
  }

  /** The raw slices for one service (detail views). */
  slicesFor(namespace: string | undefined | null, name: string): Resource[] {
    return this.byService[serviceKey(namespace, name)] ?? [];
  }

  /** Whether the loaded set includes this namespace. */
  covers(namespace: string | undefined | null): boolean {
    if (this.loadedNamespace === undefined) return false;
    if (this.loadedNamespace === null || this.loadedNamespace === "") return true;
    return this.loadedNamespace === (namespace ?? "");
  }

  isStale(now: number, namespace: string | null): boolean {
    if (this._fetchedAt === 0) return true;
    if (!this.covers(namespace)) return true;
    return now - this._fetchedAt >= ENDPOINTS_TTL_MS;
  }

  apply(slices: Resource[], namespace: string | null, now: number): void {
    const map: Record<string, Resource[]> = {};
    for (const s of slices) {
      const service = s.metadata?.labels?.[SERVICE_NAME_LABEL];
      if (!service) continue;
      const key = serviceKey(s.metadata.namespace, service);
      (map[key] ??= []).push(s);
    }
    this.byService = map;
    this.loadedNamespace = namespace;
    this._fetchedAt = now;
  }

  reset(): void {
    this.byService = {};
    this.loadedNamespace = undefined;
    this._loading = false;
    this._fetchedAt = 0;
    this._requestId += 1;
  }
}
