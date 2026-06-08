// CRD handler group — ports the Tauri "crd" commands to @kubernetes/client-node.
//
// Rust sources ported (faithful 1:1):
//   - src-tauri/src/k8s/crd/discovery.rs   (discover_crds + sensitive-field deny list)
//   - src-tauri/src/k8s/crd/listing.rs     (list_crd_resources + paging)
//   - src-tauri/src/k8s/crd/counts.rs      (get_crd_counts, concurrency-limited)
//   - src-tauri/src/k8s/crd/schema.rs      (additionalPrinterColumns + heuristics)
//   - src-tauri/src/k8s/crd/types.rs       (extract_conditions)
//   - src-tauri/src/commands/k8s_commands.rs (the #[tauri::command] wrappers)
//
// Commands implemented (EXACT Tauri command strings):
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
//   - get_crd_conditions: returns StatusCondition[] (serde renames `type`,
//       optional reason/message/last_transition_time omitted when absent).
//
// Resource projection (meta_from + dynamicToResource) is shared with the
// resources and watch paths — see electron/k8s/resource-mapping.ts.

import {
  ApiextensionsV1Api,
  CustomObjectsApi,
  type V1CustomResourceDefinition,
} from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { makeApiClient } from '../k8s/client';
import type { RawObject, Resource } from '../k8s/resource-types';
import { dynamicToResource } from '../k8s/resource-mapping';

// ===========================================================================
// Result types — mirror the serde wire-casing of the Rust crd/types.rs structs.
// ===========================================================================

/** crd/types.rs CrdInfo. */
interface CrdInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string; // "Namespaced" | "Cluster"
  short_names: string[];
}

/** crd/types.rs CrdGroup. */
interface CrdGroup {
  group: string;
  resources: CrdInfo[];
}

/** crd/types.rs CrdColumn. */
interface CrdColumn {
  name: string;
  json_path: string;
  column_type: string;
  description: string;
}

/** crd/types.rs CrdResourceList. */
interface CrdResourceList {
  items: Resource[];
  columns: CrdColumn[];
}

/**
 * crd/types.rs StatusCondition — `type_` renames to `type`; reason / message /
 * last_transition_time are `skip_serializing_if = Option::is_none` (omitted).
 */
interface StatusCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  last_transition_time?: string;
}

// ===========================================================================
// Sensitive-field deny list (mirror discovery.rs).
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
// The Rust used kube::discovery::Discovery (which enumerates ALL groups and
// then filters out the built-in ones via a deny-list). Listing CRD objects via
// apiextensions.k8s.io is the faithful @kubernetes/client-node analog: CRD
// objects are by definition the user-defined groups, so no built-in deny-list
// is needed. We emit one CrdInfo per CRD using its storage/served version.

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

async function discoverCrds(): Promise<CrdGroup[]> {
  const apiext = makeApiClient(ApiextensionsV1Api);
  const list = await apiext.listCustomResourceDefinition();

  const groupsMap = new Map<string, CrdInfo[]>();

  for (const crd of list.items) {
    const spec = crd.spec;
    if (!spec) continue;
    const group = spec.group;
    const version = preferredVersion(crd);
    if (!version) continue;
    const names = spec.names;
    const scope = spec.scope === 'Cluster' ? 'Cluster' : 'Namespaced';

    const info: CrdInfo = {
      group,
      version,
      kind: names.kind,
      plural: names.plural,
      scope,
      // Rust left short_names empty (Discovery API didn't surface them); we keep
      // parity with the original wire output by emitting [].
      short_names: [],
    };

    const arr = groupsMap.get(group);
    if (arr) arr.push(info);
    else groupsMap.set(group, [info]);
  }

  const groups: CrdGroup[] = [...groupsMap.entries()].map(([group, resources]) => {
    resources.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return { group, resources };
  });
  groups.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));

  return groups;
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
      items.push(dynamicToResource(obj, apiVersion, kind));
    }

    const token = list.metadata?.continue;
    if (token && token.length > 0) {
      continueToken = token;
    } else {
      break;
    }
  }

  // additionalPrinterColumns first; fall back to heuristics.
  let columns: CrdColumn[] = [];
  try {
    const cols = await getCrdColumns(group, version, plural);
    columns = cols.length > 0 ? cols : extractHeuristicColumns(items, 8);
  } catch {
    columns = extractHeuristicColumns(items, 8);
  }

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

  // Key: group/kind for uniqueness (mirror Rust).
  return [`${crd.group}/${crd.kind}`, count];
}

async function getCrdCounts(
  crds: CrdInfo[],
  namespace: string | undefined,
): Promise<Record<string, number>> {
  const custom = makeApiClient(CustomObjectsApi);
  const result: Record<string, number> = {};

  // Bounded-concurrency worker pool (semaphore of 20 in Rust).
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
    return discoverCrds();
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
