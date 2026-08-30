// CRD handler group — custom resource discovery, listing, counts, conditions.
//
// Commands implemented:
//   - discover_crds          (args: {})
//   - list_crd_resources     (args: { group, version, kind, plural, scope, namespace? })
//   - get_crd_counts         (args: { crds: CrdInfo[], namespace?: string | null })
//   - get_crd_conditions     (args: { resource: Resource })
//
// Wire-casing notes (frontend is source of truth):
//   - list_crd_resources: src/lib/stores/k8s.svelte.ts sends
//       { group, version, kind, plural, scope, namespace } — namespace is `null`
//       for Cluster-scoped CRDs.
//   - get_crd_counts: sends { crds, namespace }; result keyed `group/kind`.
//   - get_crd_conditions: returns StatusCondition[] (optional reason / message
//       / last_transition_time are omitted when absent).
//
// Resource projection (meta_from + dynamicToResource) is shared with the
// resources and watch paths — see electron/k8s/resource-mapping.ts.

import {
  ApiextensionsV1Api,
  CustomObjectsApi,
  type V1CustomResourceDefinition,
} from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getActiveContextName, makeApiClient, onConfigChange } from '../k8s/client';
import type { RawObject, Resource } from '../k8s/resource-types';
import { listDynamicToResource } from '../k8s/resource-mapping';
import { apiGet } from '../k8s/api';
import { createTtlCache } from '../util/ttl-cache';

// ===========================================================================
// Result types — snake_case wire casing, consumed by the renderer CRD stores.
// ===========================================================================

interface CrdInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string; // "Namespaced" | "Cluster"
  short_names: string[];
}

interface CrdGroup {
  group: string;
  resources: CrdInfo[];
}

interface CrdColumn {
  name: string;
  json_path: string;
  column_type: string;
  description: string;
}

interface CrdResourceList {
  items: Resource[];
  columns: CrdColumn[];
}

/**
 * A resource's status condition. reason / message / last_transition_time are
 * omitted when absent.
 */
interface StatusCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  last_transition_time?: string;
}

// ===========================================================================
// Sensitive-field deny list.
// ===========================================================================

const SENSITIVE_FIELD_PATTERNS = [
  'password',
  'secret',
  'token',
  'key',
  'credential',
  'apikey',
  'certificate',
  'private',
  'passphrase',
];

function isSensitiveField(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_FIELD_PATTERNS.some((p) => lower.includes(p));
}

// ===========================================================================
// discover_crds — list CustomResourceDefinitions grouped by API group.
// ===========================================================================
//
// Listing CRD objects via apiextensions.k8s.io is the primary path: CRD objects
// are by definition the user-defined groups, so no built-in deny-list is needed
// here. We emit one CrdInfo per CRD using its storage/served version. The
// discovery-API fallback below does need a deny-list, since /apis enumerates
// every group including the built-ins.

interface CrdSpecVersion {
  name?: string;
  served?: boolean;
  storage?: boolean;
}

/** Pick the discovery-preferred version: storage version, else first served, else first. */
function preferredVersion(crd: V1CustomResourceDefinition): string | undefined {
  const versions = (crd.spec?.versions ?? []) as CrdSpecVersion[];
  if (versions.length === 0) return undefined;
  const storage = versions.find((v) => v.storage === true && v.name);
  if (storage?.name) return storage.name;
  const served = versions.find((v) => v.served === true && v.name);
  if (served?.name) return served.name;
  return versions[0]?.name;
}

// Built-in API groups excluded from discovery-based CRD listing. Only used by
// the discovery fallback — the CRD object path is by definition user-defined
// groups.
const BUILTIN_GROUPS = new Set([
  '',
  'apps',
  'batch',
  'autoscaling',
  'networking.k8s.io',
  'policy',
  'rbac.authorization.k8s.io',
  'storage.k8s.io',
  'coordination.k8s.io',
  'discovery.k8s.io',
  'events.k8s.io',
  'flowcontrol.apiserver.k8s.io',
  'node.k8s.io',
  'scheduling.k8s.io',
  'certificates.k8s.io',
  'admissionregistration.k8s.io',
  'apiextensions.k8s.io',
  'apiregistration.k8s.io',
  'authentication.k8s.io',
  'authorization.k8s.io',
  'internal.apiserver.k8s.io',
  // Aggregated metrics APIs — served by metrics-server / custom adapters, not
  // user CRDs. Listing them often returns 403/404/500 on managed clusters.
  'metrics.k8s.io',
  'external.metrics.k8s.io',
  'custom.metrics.k8s.io',
]);

interface DiscoveryGroupList {
  groups?: Array<{
    name: string;
    preferredVersion?: { version?: string };
    versions?: Array<{ version: string }>;
  }>;
}

interface DiscoveryResourceList {
  resources?: Array<{
    name: string;
    kind: string;
    namespaced?: boolean;
    verbs?: string[];
    shortNames?: string[];
  }>;
}

/**
 * Fallback: enumerate groups via the discovery API (`/apis`). Needs no RBAC
 * beyond API-server access, so it works for users who cannot list CRD objects
 * at cluster scope (e.g. GKE without container.customResourceDefinitions.list).
 */
async function discoverCrdsViaDiscovery(): Promise<CrdGroup[]> {
  const groupList = await apiGet<DiscoveryGroupList>('/apis');
  const candidates = (groupList.groups ?? []).filter((g) => !BUILTIN_GROUPS.has(g.name));

  const groupsMap = new Map<string, CrdInfo[]>();
  await Promise.all(
    candidates.map(async (g) => {
      const version = g.preferredVersion?.version ?? g.versions?.[0]?.version;
      if (!version) return;
      let res: DiscoveryResourceList;
      try {
        res = await apiGet<DiscoveryResourceList>(`/apis/${g.name}/${version}`);
      } catch {
        // Aggregated API not serving / forbidden — skip the group, keep the rest.
        return;
      }
      const infos: CrdInfo[] = [];
      for (const r of res.resources ?? []) {
        if (r.name.includes('/')) continue; // subresources (status, scale, …)
        if (!(r.verbs ?? []).includes('list')) continue;
        infos.push({
          group: g.name,
          version,
          kind: r.kind,
          plural: r.name,
          scope: r.namespaced ? 'Namespaced' : 'Cluster',
          short_names: r.shortNames ?? [],
        });
      }
      if (infos.length > 0) groupsMap.set(g.name, infos);
    }),
  );

  return toSortedGroups(groupsMap);
}

/** group -> CrdInfo[] map to the wire shape: kinds sorted within each group, groups sorted by name. */
function toSortedGroups(groupsMap: Map<string, CrdInfo[]>): CrdGroup[] {
  const groups: CrdGroup[] = [...groupsMap.entries()].map(([group, resources]) => {
    resources.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return { group, resources };
  });
  groups.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  return groups;
}

/** Project CRD objects (apiextensions listing) into the grouped wire shape. */
function groupCrdObjects(items: V1CustomResourceDefinition[]): CrdGroup[] {
  const groupsMap = new Map<string, CrdInfo[]>();

  for (const crd of items) {
    const spec = crd.spec;
    if (!spec) continue;
    const version = preferredVersion(crd);
    if (!version) continue;

    const info: CrdInfo = {
      group: spec.group,
      version,
      kind: spec.names.kind,
      plural: spec.names.plural,
      scope: spec.scope === 'Cluster' ? 'Cluster' : 'Namespaced',
      short_names: spec.names.shortNames ?? [],
    };

    const arr = groupsMap.get(spec.group);
    if (arr) arr.push(info);
    else groupsMap.set(spec.group, [info]);
  }

  return toSortedGroups(groupsMap);
}

async function discoverCrds(): Promise<CrdGroup[]> {
  try {
    const apiext = makeApiClient(ApiextensionsV1Api);
    return groupCrdObjects((await apiext.listCustomResourceDefinition()).items);
  } catch {
    // Listing CRD objects needs cluster-scope RBAC many users lack; the
    // discovery API does not. Fall back to it so those users still get CRDs.
    return discoverCrdsViaDiscovery();
  }
}

// ---------------------------------------------------------------------------
// TTL caches. The sidebar re-invokes discover_crds on every refresh and
// list_crd_resources re-reads the CRD definition (columns) on every listing —
// both are effectively static, so cache them briefly. Keys embed the active
// kubeconfig context name, so a context switch never serves stale data; the
// TTL bounds staleness within a context (there is no context-change hook to
// invalidate on).
// ---------------------------------------------------------------------------

const CRD_CACHE_TTL_MS = 30_000;

function contextKey(): string {
  return getActiveContextName() ?? '';
}

const discoveryCache = createTtlCache<CrdGroup[]>(CRD_CACHE_TTL_MS);
const columnsCache = createTtlCache<CrdColumn[]>(CRD_CACHE_TTL_MS);
// Keys embed the context, so a switch cannot serve the wrong cluster — but
// without this the previous cluster's discovery stayed resident for the TTL.
onConfigChange(() => {
  discoveryCache.clear();
  columnsCache.clear();
});

function discoverCrdsCached(): Promise<CrdGroup[]> {
  return discoveryCache.get(contextKey(), discoverCrds);
}

function getCrdColumnsCached(
  group: string,
  version: string,
  plural: string,
): Promise<CrdColumn[]> {
  const key = `${contextKey()}|${group}|${version}|${plural}`;
  return columnsCache.get(key, () => getCrdColumns(group, version, plural));
}

// ===========================================================================
// CRD schema columns — additionalPrinterColumns + heuristic fallback.
// ===========================================================================

interface RawPrinterColumn {
  name?: string;
  jsonPath?: string;
  type?: string;
  description?: string;
}

/** Mirror get_crd_columns(): read additionalPrinterColumns for the version. */
async function getCrdColumns(
  group: string,
  version: string,
  plural: string,
): Promise<CrdColumn[]> {
  const apiext = makeApiClient(ApiextensionsV1Api);
  const crdName = `${plural}.${group}`;

  let crd: V1CustomResourceDefinition;
  try {
    crd = await apiext.readCustomResourceDefinition({ name: crdName });
  } catch {
    return []; // RBAC fallback: can't read CRD def.
  }

  const versions = crd.spec?.versions ?? [];
  const matching = versions.find((v) => v.name === version);
  const printerCols = (matching?.additionalPrinterColumns ?? []) as RawPrinterColumn[];

  const columns: CrdColumn[] = [];
  for (const col of printerCols) {
    const name = col.name;
    const jsonPath = col.jsonPath;
    if (name === undefined || jsonPath === undefined) continue;
    const colType = col.type ?? 'string';
    const description = col.description ?? '';

    if (isSensitiveField(name)) continue;
    if (name === 'Age' && jsonPath.includes('creationTimestamp')) continue;

    columns.push({
      name,
      json_path: jsonPath,
      column_type: colType,
      description,
    });
  }
  return columns;
}

/** Mirror extract_heuristic_columns(): derive columns from .status / .spec of the first item. */
function extractHeuristicColumns(items: Resource[], maxColumns: number): CrdColumn[] {
  if (items.length === 0) return [];

  const sample = items[0];
  const columns: CrdColumn[] = [];

  const sampleStatus =
    sample.status && typeof sample.status === 'object'
      ? (sample.status as Record<string, unknown>)
      : null;
  const sampleSpec =
    sample.spec && typeof sample.spec === 'object'
      ? (sample.spec as Record<string, unknown>)
      : null;

  const priorityPaths: Array<[string, string, 'status' | 'spec']> = [
    ['.status.phase', 'Phase', 'status'],
    ['.status.replicas', 'Replicas', 'status'],
    ['.status.readyReplicas', 'Ready', 'status'],
    ['.status.availableReplicas', 'Available', 'status'],
    ['.status.currentReplicas', 'Current Replicas', 'status'],
    ['.status.desiredReplicas', 'Desired Replicas', 'status'],
    ['.spec.replicas', 'Desired', 'spec'],
    ['.status.observedGeneration', 'Observed Gen', 'status'],
  ];

  for (const [jsonPath, name, root] of priorityPaths) {
    const rootVal = root === 'status' ? sampleStatus : sampleSpec;
    if (rootVal) {
      const field = jsonPath.split('.').pop() ?? '';
      if (
        Object.prototype.hasOwnProperty.call(rootVal, field) &&
        rootVal[field] !== undefined &&
        !isSensitiveField(field)
      ) {
        columns.push({
          name,
          json_path: jsonPath,
          column_type: 'string',
          description: '',
        });
      }
    }
    if (columns.length >= maxColumns) break;
  }

  // Scan top-level .status scalar fields (depth 1) if room remains.
  if (columns.length < maxColumns && sampleStatus) {
    for (const [key, val] of Object.entries(sampleStatus)) {
      if (columns.length >= maxColumns) break;
      if (isSensitiveField(key)) continue;
      // Skip complex objects / arrays — scalars only.
      if (val !== null && typeof val === 'object') continue;
      const path = `.status.${key}`;
      if (columns.some((c) => c.json_path === path)) continue;
      columns.push({
        name: key,
        json_path: path,
        column_type: 'string',
        description: '',
      });
    }
  }

  return columns;
}

// ===========================================================================
// list_crd_resources — list a CRD's objects + smart columns (paged at 500).
// ===========================================================================

interface RawCustomObjectList {
  items?: RawObject[];
  metadata?: { continue?: string; remainingItemCount?: number };
}

async function listCrdResources(
  group: string,
  version: string,
  kind: string,
  plural: string,
  scope: string,
  namespace: string | undefined,
): Promise<CrdResourceList> {
  const custom = makeApiClient(CustomObjectsApi);
  const apiVersion = group.length === 0 ? version : `${group}/${version}`;

  const useNamespaced = scope !== 'Cluster' && namespace !== undefined && namespace.length > 0;

  const listItems = async (): Promise<Resource[]> => {
    const items: Resource[] = [];
    let continueToken: string | undefined;

    for (;;) {
      let list: RawCustomObjectList;
      if (useNamespaced) {
        list = (await custom.listNamespacedCustomObject({
          group,
          version,
          namespace: namespace as string,
          plural,
          limit: 500,
          _continue: continueToken,
        })) as RawCustomObjectList;
      } else {
        list = (await custom.listClusterCustomObject({
          group,
          version,
          plural,
          limit: 500,
          _continue: continueToken,
        })) as RawCustomObjectList;
      }

      for (const obj of list.items ?? []) {
        items.push(listDynamicToResource(obj, apiVersion, kind));
      }

      const token = list.metadata?.continue;
      if (token && token.length > 0) {
        continueToken = token;
      } else {
        break;
      }
    }

    return items;
  };

  // Listing and column resolution are independent — run them concurrently.
  const [items, printerCols] = await Promise.all([
    listItems(),
    getCrdColumnsCached(group, version, plural).catch(() => [] as CrdColumn[]),
  ]);

  // additionalPrinterColumns first; fall back to heuristics.
  const columns = printerCols.length > 0 ? printerCols : extractHeuristicColumns(items, 8);

  return { items, columns };
}

// ===========================================================================
// get_crd_counts — count objects per CRD, concurrency-limited (semaphore=20).
// ===========================================================================

const COUNT_CONCURRENCY = 20;

async function countCrd(
  custom: CustomObjectsApi,
  crd: CrdInfo,
  namespace: string | undefined,
): Promise<[string, number]> {
  const useNamespaced =
    crd.scope !== 'Cluster' && namespace !== undefined && namespace.length > 0;

  let count = 0;
  try {
    let list: RawCustomObjectList;
    if (useNamespaced) {
      list = (await custom.listNamespacedCustomObject({
        group: crd.group,
        version: crd.version,
        namespace: namespace as string,
        plural: crd.plural,
        limit: 1,
      })) as RawCustomObjectList;
    } else {
      list = (await custom.listClusterCustomObject({
        group: crd.group,
        version: crd.version,
        plural: crd.plural,
        limit: 1,
      })) as RawCustomObjectList;
    }
    const itemsLen = list.items?.length ?? 0;
    const remaining = list.metadata?.remainingItemCount;
    count = remaining !== undefined && remaining !== null ? remaining + itemsLen : itemsLen;
  } catch {
    count = 0;
  }

  // Key: group/kind for uniqueness.
  return [`${crd.group}/${crd.kind}`, count];
}

async function getCrdCounts(
  crds: CrdInfo[],
  namespace: string | undefined,
): Promise<Record<string, number>> {
  const custom = makeApiClient(CustomObjectsApi);
  const result: Record<string, number> = {};

  // Bounded-concurrency worker pool (20 in flight).
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= crds.length) return;
      const [key, count] = await countCrd(custom, crds[i], namespace);
      result[key] = count;
    }
  }

  const workers = Array.from(
    { length: Math.min(COUNT_CONCURRENCY, crds.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return result;
}

// ===========================================================================
// get_crd_conditions — extract .status.conditions (mirror extract_conditions).
// ===========================================================================

function extractConditions(resource: Resource): StatusCondition[] {
  const status =
    resource.status && typeof resource.status === 'object'
      ? (resource.status as Record<string, unknown>)
      : null;
  if (!status) return [];
  const conditions = status.conditions;
  if (!Array.isArray(conditions)) return [];

  const out: StatusCondition[] = [];
  for (const c of conditions) {
    if (c === null || typeof c !== 'object') continue;
    const cond = c as Record<string, unknown>;
    const type = cond.type;
    const condStatus = cond.status;
    if (typeof type !== 'string' || typeof condStatus !== 'string') continue;

    const entry: StatusCondition = { type, status: condStatus };
    if (typeof cond.reason === 'string') entry.reason = cond.reason;
    if (typeof cond.message === 'string') entry.message = cond.message;
    if (typeof cond.lastTransitionTime === 'string') {
      entry.last_transition_time = cond.lastTransitionTime;
    }
    out.push(entry);
  }
  return out;
}

// ===========================================================================
// Argument coercion + registration.
// ===========================================================================

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`Missing or invalid argument: ${field}`);
}

function asCrdInfoArray(value: unknown): CrdInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      group: typeof o.group === 'string' ? o.group : '',
      version: typeof o.version === 'string' ? o.version : '',
      kind: typeof o.kind === 'string' ? o.kind : '',
      plural: typeof o.plural === 'string' ? o.plural : '',
      scope: typeof o.scope === 'string' ? o.scope : 'Namespaced',
      short_names: Array.isArray(o.short_names)
        ? (o.short_names.filter((s) => typeof s === 'string') as string[])
        : [],
    };
  });
}

function asResource(value: unknown): Resource {
  const o = (value ?? {}) as Record<string, unknown>;
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const res: Resource = {
    api_version: typeof o.api_version === 'string' ? o.api_version : '',
    kind: typeof o.kind === 'string' ? o.kind : '',
    metadata: {
      name: typeof meta.name === 'string' ? meta.name : null,
      namespace: typeof meta.namespace === 'string' ? meta.namespace : null,
      uid: typeof meta.uid === 'string' ? meta.uid : null,
      resource_version: typeof meta.resource_version === 'string' ? meta.resource_version : null,
      labels: (meta.labels as Record<string, string>) ?? null,
      annotations: (meta.annotations as Record<string, string>) ?? null,
      creation_timestamp:
        typeof meta.creation_timestamp === 'string' ? meta.creation_timestamp : null,
      owner_references: meta.owner_references ?? null,
    },
  };
  if (o.spec !== undefined) res.spec = o.spec;
  if (o.status !== undefined) res.status = o.status;
  if (o.data !== undefined) res.data = o.data;
  if (typeof o.type === 'string') res.type = o.type;
  return res;
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('discover_crds', async () => {
    return discoverCrdsCached();
  });

  handlers.set('list_crd_resources', async (args) => {
    return listCrdResources(
      requireString(args.group, 'group'),
      requireString(args.version, 'version'),
      requireString(args.kind, 'kind'),
      requireString(args.plural, 'plural'),
      requireString(args.scope, 'scope'),
      asOptionalString(args.namespace),
    );
  });

  handlers.set('get_crd_counts', async (args) => {
    return getCrdCounts(asCrdInfoArray(args.crds), asOptionalString(args.namespace));
  });

  handlers.set('get_crd_conditions', async (args) => {
    return extractConditions(asResource(args.resource));
  });
}
