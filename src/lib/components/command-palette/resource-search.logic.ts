// Global resource search for the command palette.
//
// The palette's static items navigate to *types* ("Pods", "Deployments"); this
// module finds *objects* by name across kinds and namespaces, so typing
// `payments` surfaces `deploy/payments-api`, its pods, its Service and its
// Secret without first knowing where they live.
//
// Plain TypeScript — no Svelte runes, no IPC. The palette injects a `listFn`
// (a thin wrapper over `list_resources`) and the RBAC-filtered namespace list
// it already holds; everything here is unit-testable under `bun test`.

import type { Resource } from "$lib/types";
import { RESOURCE_ITEMS } from "$lib/resource-catalog";

/** Kinds the search covers, in result-group order. A deliberate subset: the
 *  kinds people look up by name. Leases, EndpointSlices and friends would only
 *  add noise (and list volume). */
export const SEARCHABLE_TYPES: readonly string[] = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "pods",
  "services",
  "ingresses",
  "cronjobs",
  "jobs",
  "configmaps",
  "secrets",
  "persistentvolumeclaims",
  "serviceaccounts",
  "hpa",
  "nodes",
  "namespaces",
];

const CLUSTER_SCOPED = new Set(["nodes", "namespaces"]);

/** Fewest characters before the palette starts searching the cluster. */
export const MIN_SEARCH_LENGTH = 2;

export interface ParsedSearchQuery {
  /** Free-text terms, lowercased; every one must match the object name. */
  terms: string[];
  /** `kind:` / `k:` filter resolved to a resource_type; undefined = all. */
  resourceType?: string;
  /** `ns:` / `namespace:` filter, lowercased; undefined = all. */
  namespace?: string;
}

/**
 * Resolve `kind:` values: the resource_type ("deployments"), the kubectl short
 * name ("deploy"), the Kind ("Deployment") or a lowercase Kind — whatever the
 * user types at a kubectl prompt.
 */
export function resolveKindFilter(value: string): string | undefined {
  const v = value.toLowerCase();
  if (!v) return undefined;
  return RESOURCE_ITEMS.find((item) => !item.virtual && (item.type === v || item.short === v || item.kind?.toLowerCase() === v))?.type;
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = { terms: [] };
  for (const raw of query.trim().split(/\s+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    const colon = lower.indexOf(":");
    if (colon > 0) {
      const key = lower.slice(0, colon);
      const value = lower.slice(colon + 1);
      if (key === "ns" || key === "namespace") {
        parsed.namespace = value || undefined;
        continue;
      }
      if (key === "kind" || key === "k" || key === "type") {
        // An unknown kind filter keeps the literal so "kind:foo" matches nothing
        // rather than silently searching everything.
        parsed.resourceType = resolveKindFilter(value) ?? (value ? `unknown:${value}` : undefined);
        continue;
      }
    }
    parsed.terms.push(lower);
  }
  return parsed;
}

/**
 * How well `name` matches every term. 0 = at least one term missing. Higher
 * is better: exact > prefix > segment start ("api" in "payments-api") >
 * substring. Scores add across terms so multi-term queries rank naturally.
 */
export function scoreName(name: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = name.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (lower === term) total += 100;
    else if (lower.startsWith(term)) total += 60;
    else if (lower.includes(`-${term}`) || lower.includes(`.${term}`) || lower.includes(`_${term}`)) total += 40;
    else if (lower.includes(term)) total += 20;
    else return 0;
  }
  // Shorter names that match are more likely the thing meant: `payments-api`
  // over `payments-api-7f9c8d-x2k`. Tie-break only; never beats a better class.
  return total - Math.min(lower.length, 19) / 20;
}

export interface SearchHit {
  resource: Resource;
  resourceType: string;
  score: number;
}

export type ListFn = (resourceType: string, namespace?: string) => Promise<Resource[]>;

export interface ResourceSearchIndexOptions {
  /** How long a loaded type stays fresh. */
  ttlMs?: number;
  now?: () => number;
  /** Cap on the per-namespace fan-out when cluster-wide listing is forbidden. */
  maxNamespaces?: number;
  types?: readonly string[];
}

/**
 * A lazily filled, per-type cache of list projections that `search()` ranks
 * synchronously. `ensureLoaded()` lists each type cluster-wide first; when
 * that is refused (403 under namespace-scoped RBAC) it fans out over the
 * namespaces the app already knows it can read, and remembers the refusal so
 * later refreshes skip the doomed call.
 */
export class ResourceSearchIndex {
  private readonly cache = new Map<string, { items: Resource[]; loadedAt: number }>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** Types whose cluster-wide list failed — fan out per namespace instead. */
  readonly clusterScopeRefused = new Set<string>();
  /** Last error per type, for the palette to explain an empty result. */
  readonly errors = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxNamespaces: number;
  readonly types: readonly string[];
  constructor(private readonly listFn: ListFn, opts: ResourceSearchIndexOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.maxNamespaces = opts.maxNamespaces ?? 40;
    this.types = opts.types ?? SEARCHABLE_TYPES;
  }

  get loading(): boolean {
    return this.inflight.size > 0;
  }

  /** True once every searchable type has been listed at least once. */
  get ready(): boolean {
    return this.types.every((t) => this.cache.has(t));
  }

  /** Drop everything — context switch, explicit refresh. */
  invalidate(): void {
    this.cache.clear();
    this.clusterScopeRefused.clear();
    this.errors.clear();
  }

  /**
   * Refresh every stale type. Resolves when all loads settle (never rejects —
   * a kind the user cannot list simply contributes no hits). `onProgress`
   * fires after each type lands so the UI can rank what it has so far.
   */
  async ensureLoaded(namespaces: readonly string[], onProgress?: () => void): Promise<void> {
    const now = this.now();
    const loads: Promise<void>[] = [];
    for (const type of this.types) {
      const entry = this.cache.get(type);
      if (entry && now - entry.loadedAt < this.ttlMs) continue;
      loads.push(this.loadType(type, namespaces, onProgress));
    }
    await Promise.all(loads);
  }

  private loadType(type: string, namespaces: readonly string[], onProgress?: () => void): Promise<void> {
    const existing = this.inflight.get(type);
    if (existing) return existing;
    const task = (async () => {
      try {
        const items = await this.fetchType(type, namespaces);
        this.cache.set(type, { items, loadedAt: this.now() });
        this.errors.delete(type);
      } catch (err) {
        this.errors.set(type, err instanceof Error ? err.message : String(err));
        // Keep a stale entry rather than nothing: old hits beat no hits.
        if (!this.cache.has(type)) this.cache.set(type, { items: [], loadedAt: this.now() });
      } finally {
        this.inflight.delete(type);
        onProgress?.();
      }
    })();
    this.inflight.set(type, task);
    return task;
  }

  private async fetchType(type: string, namespaces: readonly string[]): Promise<Resource[]> {
    if (CLUSTER_SCOPED.has(type)) return this.listFn(type);
    if (!this.clusterScopeRefused.has(type)) {
      try {
        return await this.listFn(type, "");
      } catch {
        this.clusterScopeRefused.add(type);
      }
    }
    const scoped = namespaces.slice(0, this.maxNamespaces);
    const results = await Promise.allSettled(scoped.map((ns) => this.listFn(type, ns)));
    const items: Resource[] = [];
    let failures = 0;
    for (const r of results) {
      if (r.status === "fulfilled") items.push(...r.value);
      else failures++;
    }
    if (failures === results.length && results.length > 0) {
      throw new Error(`Cannot list ${type} in any namespace`);
    }
    return items;
  }

  /** Rank cached objects against `query`. Synchronous; call after loading. */
  search(query: string, limit = 30): SearchHit[] {
    const parsed = parseSearchQuery(query);
    if (parsed.terms.length === 0 && !parsed.resourceType && !parsed.namespace) return [];
    const hits: SearchHit[] = [];
    for (const type of this.types) {
      if (parsed.resourceType && parsed.resourceType !== type) continue;
      const entry = this.cache.get(type);
      if (!entry) continue;
      for (const resource of entry.items) {
        const ns = resource.metadata.namespace?.toLowerCase();
        if (parsed.namespace && ns !== parsed.namespace) continue;
        // With only filters and no terms, list everything in scope (cheap
        // "what is in ns:billing").
        const score = parsed.terms.length === 0 ? 1 : scoreName(resource.metadata.name, parsed.terms);
        if (score <= 0) continue;
        hits.push({ resource, resourceType: type, score });
      }
    }
    // Best score first; same score keeps type order (deployments before their
    // pods) then name, so results are stable between keystrokes.
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = this.types.indexOf(a.resourceType);
      const tb = this.types.indexOf(b.resourceType);
      if (ta !== tb) return ta - tb;
      return a.resource.metadata.name.localeCompare(b.resource.metadata.name);
    });
    return hits.slice(0, limit);
  }
}
