// Handler module: resources group.
//
// Ports src-tauri/src/k8s/resources/* (listing.rs, types.rs, events.rs,
// counting.rs, helpers.rs) to @kubernetes/client-node.
//
// Commands:
//   - list_resources           list a kind, optionally namespaced (pods get a
//                              lean field projection for the hot table path)
//   - list_pods_by_selector    list pods filtered by a label selector
//   - get_resource_counts      metadata-only counts for many kinds at once
//   - get_resource_yaml        fetch one object, strip managedFields, -> YAML
//   - get_resource             fetch one object with FULL spec/status/data
//   - get_events               list events, optional ns + field selector
//   - get_resource_events      events for one named resource
//
// WIRE CASING — the Rust types drive the JSON the Svelte stores consume:
//   * Resource / ResourceMetadata / ResourceList have NO serde(rename_all), so
//     their top-level keys stay snake_case: api_version, resource_version,
//     creation_timestamp, owner_references. (`type` is renamed from type_.)
//   * The PROJECTED pod spec/status structs DO use rename_all="camelCase", and
//     the raw k8s API already returns camelCase inside spec/status — so the
//     nested bodies (nodeName, podIP, containerStatuses, ...) stay camelCase.
//   * EventItem keeps snake_case keys (first_timestamp, involved_object, ...)
//     with `type` renamed; the inner involvedObject object stays camelCase.

import * as YAML from 'yaml';

import { getCoreV1Api, kc } from '../k8s/client';
import type {
  RawList,
  RawObject,
  RawObjectMeta,
  Resource,
  ResourceList,
  ResourceMetadata,
} from '../k8s/resource-types';
import { metaFrom } from '../k8s/resource-mapping';
import { apiVersionOf, resolveKindOrThrow } from '../k8s/kinds';
import type { Handler, HandlerMap } from '../dispatch';

// ---------------------------------------------------------------------------
// Wire types. Resource/ResourceMetadata/ResourceList/Raw* come from the shared
// k8s core; only the resources-specific Event shapes live here.
// ---------------------------------------------------------------------------

interface EventItem {
  name?: string;
  namespace?: string;
  reason?: string;
  message?: string;
  type?: string;
  involved_object?: unknown;
  first_timestamp?: string;
  last_timestamp?: string;
  count?: number;
  source?: unknown;
}

// ---------------------------------------------------------------------------
// Raw k8s API shapes. RawObjectMeta/RawObject/RawList come from the shared core;
// only the resources-specific Event raw shapes live here.
// ---------------------------------------------------------------------------

interface RawEvent {
  metadata?: RawObjectMeta;
  reason?: string;
  message?: string;
  type?: string;
  involvedObject?: unknown;
  firstTimestamp?: string;
  lastTimestamp?: string;
  count?: number;
  source?: unknown;
}

interface RawEventList {
  items?: RawEvent[];
}

// ---------------------------------------------------------------------------
// ApiResource resolution (port of helpers.rs api_resource_for_kind + the
// per-resource_type group/version/plural the listing macros encode)
// ---------------------------------------------------------------------------

interface ApiResource {
  group: string;
  version: string;
  apiVersion: string;
  plural: string;
  clusterScoped: boolean;
}

const LIST_PAGE_SIZE = 500;

/**
 * Resolve the (group, version, plural, scope) for a PLURAL resource_type as used
 * by list_resources / get_resource_counts. Mirrors the listing.rs match. This is
 * keyed by the frontend's plural resourceType (pods, deployments, hpa, vpa, …) —
 * a distinct key space from the singular kind registry, so it stays local.
 * `undefined` for unknown types (the caller decides how to error).
 */
function apiResourceForType(resourceType: string): ApiResource | undefined {
  // [group, version, plural, clusterScoped]
  const table: Record<string, [string, string, string, boolean]> = {
    pods: ['', 'v1', 'pods', false],
    deployments: ['apps', 'v1', 'deployments', false],
    services: ['', 'v1', 'services', false],
    configmaps: ['', 'v1', 'configmaps', false],
    secrets: ['', 'v1', 'secrets', false],
    ingresses: ['networking.k8s.io', 'v1', 'ingresses', false],
    statefulsets: ['apps', 'v1', 'statefulsets', false],
    daemonsets: ['apps', 'v1', 'daemonsets', false],
    jobs: ['batch', 'v1', 'jobs', false],
    cronjobs: ['batch', 'v1', 'cronjobs', false],
    replicasets: ['apps', 'v1', 'replicasets', false],
    nodes: ['', 'v1', 'nodes', true],
    namespaces: ['', 'v1', 'namespaces', true],
    hpa: ['autoscaling', 'v2', 'horizontalpodautoscalers', false],
    vpa: ['autoscaling.k8s.io', 'v1', 'verticalpodautoscalers', false],
    networkpolicies: ['networking.k8s.io', 'v1', 'networkpolicies', false],
    persistentvolumes: ['', 'v1', 'persistentvolumes', true],
    persistentvolumeclaims: ['', 'v1', 'persistentvolumeclaims', false],
    storageclasses: ['storage.k8s.io', 'v1', 'storageclasses', true],
    roles: ['rbac.authorization.k8s.io', 'v1', 'roles', false],
    rolebindings: ['rbac.authorization.k8s.io', 'v1', 'rolebindings', false],
    clusterroles: ['rbac.authorization.k8s.io', 'v1', 'clusterroles', true],
    clusterrolebindings: ['rbac.authorization.k8s.io', 'v1', 'clusterrolebindings', true],
    resourcequotas: ['', 'v1', 'resourcequotas', false],
    limitranges: ['', 'v1', 'limitranges', false],
    poddisruptionbudgets: ['policy', 'v1', 'poddisruptionbudgets', false],
  };
  const row = table[resourceType];
  if (!row) return undefined;
  const [group, version, plural, clusterScoped] = row;
  return { group, version, apiVersion: apiVersionOf(group, version), plural, clusterScoped };
}

/**
 * Resolve the ApiResource for a SINGULAR kind string (used by get_resource /
 * get_resource_yaml). Port of helpers.rs api_resource_for_kind. Throws the same
 * "Unsupported kind for YAML fetch: <kind>" error on unknown kinds.
 *
 * Returns the kind string verbatim (Rust keeps the caller's `kind` casing in
 * the returned Resource.kind / ApiResource.kind).
 */
function apiResourceForKind(kind: string): { ar: ApiResource; clusterScoped: boolean } {
  const k = resolveKindOrThrow(kind);
  return {
    ar: {
      group: k.group,
      version: k.version,
      apiVersion: apiVersionOf(k.group, k.version),
      plural: k.plural,
      clusterScoped: k.clusterScoped,
    },
    clusterScoped: k.clusterScoped,
  };
}

// metaFrom now lives in electron/k8s/resource-mapping.ts (shared).

/** Drop a value if it is null/undefined (Rust's `.filter(|v| !v.is_null())`). */
function presentOrUndefined<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

// ---------------------------------------------------------------------------
// Generic paginated list against the dynamic CustomObjects endpoint.
//
// Core resources are reachable with group="" / version="v1"; this mirrors the
// Rust DynamicObject path and lets every kind share one projection pass.
// ---------------------------------------------------------------------------

interface ListOpts {
  ar: ApiResource;
  namespace?: string;
  labelSelector?: string;
  paginate?: boolean; // pods/deployments/etc. paginate; bindings do a single list
  accept?: string; // optional content negotiation (e.g. metadata-only for counts)
}

// Metadata-only content negotiation: the apiserver returns a
// PartialObjectMetadataList (just metadata, no spec/status/managedFields) for
// any resource that supports it — a fraction of the full-body payload, which is
// all counting needs. Falls back to a normal list for the rare kind that 406s.
const META_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json';

/**
 * Build the REST base path for a resource. Core-group resources (group="")
 * live under /api/v1/...; grouped resources under /apis/{group}/{version}/...
 * The k8s CustomObjectsApi can't address the core group (it hard-errors on an
 * empty group and always emits /apis), so we route every kind ourselves.
 */
function resourcePath(ar: ApiResource, namespace?: string): string {
  const base =
    ar.group === ''
      ? `/api/${ar.version}`
      : `/apis/${ar.group}/${ar.version}`;
  const scoped =
    !ar.clusterScoped && namespace !== undefined && namespace !== ''
      ? `${base}/namespaces/${encodeURIComponent(namespace)}/${ar.plural}`
      : `${base}/${ar.plural}`;
  return scoped;
}

/** Issue an authenticated GET against the active cluster, returning parsed JSON. */
async function apiGet<T>(
  path: string,
  query?: Record<string, string>,
  accept?: string,
): Promise<T> {
  const cfg = kc();
  const cluster = cfg.getCurrentCluster();
  if (!cluster) {
    throw new Error('No active cluster in kubeconfig');
  }
  const url = new URL(cluster.server.replace(/\/$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }

  // applyToFetchOptions injects auth headers + the TLS agent (client certs/CA).
  const opts = await cfg.applyToFetchOptions({});
  opts.method = 'GET';
  if (accept) {
    // Content negotiation (e.g. PartialObjectMetadataList for counts) — far
    // smaller payloads, much faster to transfer + JSON.parse.
    opts.headers = { ...(opts.headers as Record<string, string> | undefined), Accept: accept };
  }

  const resp = await fetch(url.toString(), opts as RequestInit);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}${body ? `: ${body}` : ''}`);
  }
  return (await resp.json()) as T;
}

async function listRaw(opts: ListOpts): Promise<RawObject[]> {
  const { ar, namespace, labelSelector, paginate = true, accept } = opts;
  const path = resourcePath(ar, namespace);
  const items: RawObject[] = [];
  let cont: string | undefined;

  // Loop while there is a continue token (matches the Rust continue-token loop).
  for (;;) {
    const query: Record<string, string> = {};
    if (labelSelector) query.labelSelector = labelSelector;
    if (paginate) query.limit = String(LIST_PAGE_SIZE);
    if (cont) query.continue = cont;

    const list = await apiGet<RawList>(path, query, accept);
    if (list.items) items.push(...list.items);

    const token = list.metadata?.continue;
    if (!paginate || !token || token.length === 0) break;
    cont = token;
  }

  return items;
}

async function getRaw(ar: ApiResource, name: string, namespace: string): Promise<RawObject> {
  const base = resourcePath(ar, ar.clusterScoped ? undefined : namespace);
  return apiGet<RawObject>(`${base}/${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// Per-kind projection of a raw object into a Resource.
//
// `fields` selects which of spec/status/data ride along, matching the
// spec=/status=/data= flags the Rust listing macros pass per kind.
// ---------------------------------------------------------------------------

interface FieldSel {
  spec: boolean;
  status: boolean;
  data: boolean;
}

function projectGeneric(
  obj: RawObject,
  apiVersion: string,
  kind: string,
  fields: FieldSel,
): Resource {
  const res: Resource = {
    api_version: apiVersion,
    kind,
    metadata: metaFrom(obj.metadata),
  };
  if (fields.spec) {
    const v = presentOrUndefined(obj.spec);
    if (v !== undefined) res.spec = v;
  }
  if (fields.status) {
    const v = presentOrUndefined(obj.status);
    if (v !== undefined) res.status = v;
  }
  if (fields.data) {
    const v = presentOrUndefined(obj.data);
    if (v !== undefined) res.data = v;
  }
  return res;
}

// Per resource_type: api_version + kind + which fields project. Mirrors the
// listing.rs match arms (note kind is the SINGULAR Kind, e.g. "Pod").
// Entries handled specially (pods, secrets, bindings, vpa) are omitted here.
const GENERIC_KIND_TABLE: Record<
  string,
  { apiVersion: string; kind: string; fields: FieldSel }
> = {
  deployments: { apiVersion: 'apps/v1', kind: 'Deployment', fields: { spec: true, status: true, data: false } },
  services: { apiVersion: 'v1', kind: 'Service', fields: { spec: true, status: true, data: false } },
  configmaps: { apiVersion: 'v1', kind: 'ConfigMap', fields: { spec: false, status: false, data: true } },
  ingresses: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', fields: { spec: true, status: true, data: false } },
  statefulsets: { apiVersion: 'apps/v1', kind: 'StatefulSet', fields: { spec: true, status: true, data: false } },
  daemonsets: { apiVersion: 'apps/v1', kind: 'DaemonSet', fields: { spec: true, status: true, data: false } },
  jobs: { apiVersion: 'batch/v1', kind: 'Job', fields: { spec: true, status: true, data: false } },
  cronjobs: { apiVersion: 'batch/v1', kind: 'CronJob', fields: { spec: true, status: true, data: false } },
  replicasets: { apiVersion: 'apps/v1', kind: 'ReplicaSet', fields: { spec: true, status: true, data: false } },
  nodes: { apiVersion: 'v1', kind: 'Node', fields: { spec: true, status: true, data: false } },
  namespaces: { apiVersion: 'v1', kind: 'Namespace', fields: { spec: true, status: true, data: false } },
  hpa: { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', fields: { spec: true, status: true, data: false } },
  networkpolicies: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', fields: { spec: true, status: false, data: false } },
  persistentvolumes: { apiVersion: 'v1', kind: 'PersistentVolume', fields: { spec: true, status: true, data: false } },
  persistentvolumeclaims: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', fields: { spec: true, status: true, data: false } },
  storageclasses: { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', fields: { spec: false, status: false, data: false } },
  roles: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', fields: { spec: false, status: false, data: false } },
  clusterroles: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', fields: { spec: false, status: false, data: false } },
  resourcequotas: { apiVersion: 'v1', kind: 'ResourceQuota', fields: { spec: true, status: true, data: false } },
  limitranges: { apiVersion: 'v1', kind: 'LimitRange', fields: { spec: true, status: false, data: false } },
  poddisruptionbudgets: { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', fields: { spec: true, status: true, data: false } },
};

// ---------------------------------------------------------------------------
// Pod projection — port of listing.rs list_pods_projected.
//
// The pods table only reads a handful of fields; project them so we never ship
// the full spec/status. The keys MUST match what TableRow.getCellValue +
// container status rendering read (and src/lib/types PodStatus/ContainerStatus):
//   spec.nodeName, spec.containers[].{name,image}, spec.initContainers[].{name,image}
//   status.{phase,podIP,hostIP,startTime}
//   status.conditions[].{type,status}
//   status.containerStatuses[].{name,ready,restartCount,image,state,started}
//   status.initContainerStatuses[...]
// ---------------------------------------------------------------------------

interface RawContainer {
  name?: string;
  image?: string;
}
interface RawCondition {
  type?: string;
  status?: string;
}
interface RawContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  image?: string;
  state?: unknown;
  started?: boolean;
}
interface RawPodSpec {
  nodeName?: string;
  containers?: RawContainer[];
  initContainers?: RawContainer[];
}
interface RawPodStatus {
  phase?: string;
  podIP?: string;
  hostIP?: string;
  startTime?: string;
  conditions?: RawCondition[];
  containerStatuses?: RawContainerStatus[];
  initContainerStatuses?: RawContainerStatus[];
}

/** Drop undefined-valued keys so the object matches serde skip_serializing_if. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function projectContainer(c: RawContainer): Partial<RawContainer> {
  return compact({ name: c.name, image: c.image });
}

function projectContainerStatus(cs: RawContainerStatus): Partial<RawContainerStatus> {
  return compact({
    name: cs.name,
    ready: cs.ready,
    restartCount: cs.restartCount,
    image: cs.image,
    state: cs.state,
    started: cs.started,
  });
}

function projectPod(obj: RawObject): Resource {
  const rawSpec = (obj.spec ?? undefined) as RawPodSpec | undefined;
  const rawStatus = (obj.status ?? undefined) as RawPodStatus | undefined;

  let spec: Record<string, unknown> | undefined;
  if (rawSpec) {
    const s = compact({
      nodeName: rawSpec.nodeName,
      containers: rawSpec.containers?.map(projectContainer),
      initContainers: rawSpec.initContainers?.map(projectContainer),
    });
    spec = Object.keys(s).length > 0 ? s : undefined;
  }

  let status: Record<string, unknown> | undefined;
  if (rawStatus) {
    const st = compact({
      phase: rawStatus.phase,
      podIP: rawStatus.podIP,
      hostIP: rawStatus.hostIP,
      startTime: rawStatus.startTime,
      conditions: rawStatus.conditions?.map((c) => compact({ type: c.type, status: c.status })),
      containerStatuses: rawStatus.containerStatuses?.map(projectContainerStatus),
      initContainerStatuses: rawStatus.initContainerStatuses?.map(projectContainerStatus),
    });
    status = Object.keys(st).length > 0 ? st : undefined;
  }

  const res: Resource = {
    api_version: 'v1',
    kind: 'Pod',
    metadata: metaFrom(obj.metadata),
  };
  if (spec !== undefined) res.spec = spec;
  if (status !== undefined) res.status = status;
  return res;
}

// ---------------------------------------------------------------------------
// Special-case projections
// ---------------------------------------------------------------------------

/** base64-encode every Secret data value; fall back to stringData. */
function projectSecret(obj: RawObject): Resource {
  let data: Record<string, string> | undefined;
  if (obj.data && typeof obj.data === 'object') {
    // Secret.data values arrive already base64-encoded from the JSON API, so
    // pass them through verbatim — matches the Rust output (which base64s the
    // decoded bytes back to the same string).
    data = obj.data as Record<string, string>;
  } else if (obj.stringData) {
    data = obj.stringData;
  }
  const res: Resource = {
    api_version: 'v1',
    kind: 'Secret',
    metadata: metaFrom(obj.metadata),
  };
  if (data !== undefined) res.data = data;
  if (obj.type !== undefined) res.type = obj.type;
  return res;
}

/** RoleBinding / ClusterRoleBinding -> synthetic spec { roleRef, subjects }. */
function projectBinding(obj: RawObject, kind: string): Resource {
  const spec: Record<string, unknown> = {};
  if (obj.roleRef !== undefined) spec.roleRef = obj.roleRef;
  if (obj.subjects !== undefined) spec.subjects = obj.subjects;
  return {
    api_version: 'rbac.authorization.k8s.io/v1',
    kind,
    metadata: metaFrom(obj.metadata),
    spec,
  };
}

/** VPA (CRD) -> spec/status pulled straight from the object body. */
function projectVpa(obj: RawObject): Resource {
  const res: Resource = {
    api_version: 'autoscaling.k8s.io/v1',
    kind: 'VerticalPodAutoscaler',
    metadata: metaFrom(obj.metadata),
  };
  const spec = presentOrUndefined(obj.spec);
  const status = presentOrUndefined(obj.status);
  if (spec !== undefined) res.spec = spec;
  if (status !== undefined) res.status = status;
  return res;
}

// ---------------------------------------------------------------------------
// list_resources
// ---------------------------------------------------------------------------

async function listResources(resourceType: string, namespace?: string): Promise<ResourceList> {
  // Pods: lean projection (hot path).
  if (resourceType === 'pods') {
    const ar = apiResourceForType('pods');
    if (!ar) throw new Error(`Unknown resource type: ${resourceType}`);
    const raw = await listRaw({ ar, namespace });
    return { items: raw.map(projectPod) };
  }

  // Secrets: base64 data + type.
  if (resourceType === 'secrets') {
    const ar = apiResourceForType('secrets');
    if (!ar) throw new Error(`Unknown resource type: ${resourceType}`);
    // Rust uses a single (non-paginated) list for secrets.
    const raw = await listRaw({ ar, namespace, paginate: false });
    return { items: raw.map(projectSecret) };
  }

  // RBAC bindings: synthetic spec. Rust does a single list here.
  if (resourceType === 'rolebindings' || resourceType === 'clusterrolebindings') {
    const ar = apiResourceForType(resourceType);
    if (!ar) throw new Error(`Unknown resource type: ${resourceType}`);
    const kind = resourceType === 'rolebindings' ? 'RoleBinding' : 'ClusterRoleBinding';
    const raw = await listRaw({ ar, namespace, paginate: false });
    return { items: raw.map((o) => projectBinding(o, kind)) };
  }

  // VPA: CRD via dynamic group.
  if (resourceType === 'vpa') {
    const ar = apiResourceForType('vpa');
    if (!ar) throw new Error(`Unknown resource type: ${resourceType}`);
    const raw = await listRaw({ ar, namespace, paginate: false });
    return { items: raw.map(projectVpa) };
  }

  // Generic kinds (pods/deployments/services/... handled by table).
  const meta = GENERIC_KIND_TABLE[resourceType];
  if (meta) {
    const ar = apiResourceForType(resourceType);
    if (!ar) throw new Error(`Unknown resource type: ${resourceType}`);
    const raw = await listRaw({ ar, namespace });
    return { items: raw.map((o) => projectGeneric(o, meta.apiVersion, meta.kind, meta.fields)) };
  }

  throw new Error(`Unknown resource type: ${resourceType}`);
}

// ---------------------------------------------------------------------------
// list_pods_by_selector
// ---------------------------------------------------------------------------

async function listPodsBySelector(namespace: string, selector: string): Promise<ResourceList> {
  const ar = apiResourceForType('pods')!;
  // Rust uses Api::namespaced/all with a label selector, single list (no paging).
  const raw = await listRaw({
    ar,
    namespace: namespace.length === 0 ? undefined : namespace,
    labelSelector: selector,
    paginate: false,
  });
  // Full spec/status (matches list_pods_by_selector, which serializes the whole
  // pod spec/status, NOT the lean projection).
  const items = raw.map((obj) => {
    const res: Resource = {
      api_version: 'v1',
      kind: 'Pod',
      metadata: metaFrom(obj.metadata),
    };
    const spec = presentOrUndefined(obj.spec);
    const status = presentOrUndefined(obj.status);
    if (spec !== undefined) res.spec = spec;
    if (status !== undefined) res.status = status;
    return res;
  });
  return { items };
}

// ---------------------------------------------------------------------------
// get_resource (full object) + get_resource_yaml
// ---------------------------------------------------------------------------

async function getResource(kind: string, name: string, namespace: string): Promise<Resource> {
  const { ar } = apiResourceForKind(kind);
  const obj = await getRaw(ar, name, namespace);
  if (obj.metadata) obj.metadata.managedFields = undefined;

  const res: Resource = {
    api_version: ar.apiVersion,
    kind, // keep caller's kind string verbatim (Rust does kind.to_string())
    metadata: metaFrom(obj.metadata),
  };
  const spec = presentOrUndefined(obj.spec);
  const status = presentOrUndefined(obj.status);
  const data = presentOrUndefined(obj.data);
  if (spec !== undefined) res.spec = spec;
  if (status !== undefined) res.status = status;
  if (data !== undefined) res.data = data;
  if (typeof obj.type === 'string') res.type = obj.type;
  return res;
}

async function getResourceYaml(kind: string, name: string, namespace: string): Promise<string> {
  const { ar } = apiResourceForKind(kind);
  const obj = await getRaw(ar, name, namespace);
  // Strip managedFields — verbose server-side-apply noise.
  if (obj.metadata) delete obj.metadata.managedFields;
  return YAML.stringify(obj);
}

// ---------------------------------------------------------------------------
// Counts — port of counting.rs (metadata-only list, .items.len()).
//
// CustomObjects has no list_metadata; we list and count .items. The wire/serde
// payload differs from the Rust PartialObjectMeta optimization, but the count
// value is identical, which is all the frontend reads.
// ---------------------------------------------------------------------------

async function countResourceType(resourceType: string, namespace?: string): Promise<number> {
  const ar = apiResourceForType(resourceType);
  if (!ar) return 0; // Rust returns 0 for unknown/unsupported types.
  // Fast path: metadata-only list (no spec/status/managedFields). This runs for
  // ~25 kinds on every context/namespace switch (sidebar badges), so shrinking
  // each payload from full bodies to bare metadata is the dominant navigation win.
  try {
    const items = await listRaw({ ar, namespace, accept: META_ACCEPT });
    return items.length;
  } catch {
    // The kind doesn't support metadata negotiation (some CRDs 406) — fall back
    // to a full-body list so the count stays correct rather than wrongly 0.
    try {
      const items = await listRaw({ ar, namespace });
      return items.length;
    } catch {
      // VPA CRD (and any flaky kind) -> 0, matching the Rust unwrap_or(0) path.
      return 0;
    }
  }
}

async function getResourceCounts(
  resourceTypes: string[],
  namespace?: string,
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    resourceTypes.map(async (rt) => [rt, await countResourceType(rt, namespace)] as const),
  );
  const out: Record<string, number> = {};
  for (const [rt, count] of entries) out[rt] = count;
  return out;
}

// ---------------------------------------------------------------------------
// Events — port of events.rs
// ---------------------------------------------------------------------------

function eventFrom(e: RawEvent): EventItem {
  const item: EventItem = {
    name: e.metadata?.name,
    namespace: e.metadata?.namespace,
    reason: e.reason,
    message: e.message,
    type: e.type,
    involved_object: presentOrUndefined(e.involvedObject),
    first_timestamp: e.firstTimestamp,
    last_timestamp: e.lastTimestamp,
    count: e.count,
    source: presentOrUndefined(e.source),
  };
  return item;
}

async function getEvents(namespace?: string, fieldSelector?: string): Promise<EventItem[]> {
  const core = getCoreV1Api();
  let list: RawEventList;
  if (namespace === undefined || namespace === null) {
    list = (await core.listEventForAllNamespaces(
      fieldSelector ? { fieldSelector } : {},
    )) as RawEventList;
  } else {
    list = (await core.listNamespacedEvent({
      namespace,
      ...(fieldSelector ? { fieldSelector } : {}),
    })) as RawEventList;
  }
  return (list.items ?? []).map(eventFrom);
}

// Plural resource_type -> involvedObject.kind (port of events.rs match).
const EVENT_KIND_MAP: Record<string, string> = {
  pods: 'Pod',
  deployments: 'Deployment',
  services: 'Service',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
  jobs: 'Job',
  cronjobs: 'CronJob',
  replicasets: 'ReplicaSet',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  ingresses: 'Ingress',
  nodes: 'Node',
  namespaces: 'Namespace',
  hpa: 'HorizontalPodAutoscaler',
  networkpolicies: 'NetworkPolicy',
  persistentvolumes: 'PersistentVolume',
  persistentvolumeclaims: 'PersistentVolumeClaim',
  storageclasses: 'StorageClass',
  roles: 'Role',
  rolebindings: 'RoleBinding',
  clusterroles: 'ClusterRole',
  clusterrolebindings: 'ClusterRoleBinding',
  resourcequotas: 'ResourceQuota',
  limitranges: 'LimitRange',
  poddisruptionbudgets: 'PodDisruptionBudget',
};

async function getResourceEvents(
  resourceType: string,
  name: string,
  namespace: string,
): Promise<EventItem[]> {
  // Unknown types fall through to the verbatim resource_type (Rust `other => other`).
  const kind = EVENT_KIND_MAP[resourceType] ?? resourceType;
  const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${kind}`;
  const ns = namespace.length === 0 ? undefined : namespace;
  return getEvents(ns, fieldSelector);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function register(handlers: HandlerMap): void {
  const listResourcesHandler: Handler = async (args) => {
    const resourceType = str(args.resourceType);
    // namespace is Option<String> in Rust; the frontend sends null for cluster-wide.
    const ns = optStr(args.namespace);
    return listResources(resourceType, ns);
  };

  const listPodsBySelectorHandler: Handler = async (args) => {
    return listPodsBySelector(str(args.namespace), str(args.selector));
  };

  const getResourceCountsHandler: Handler = async (args) => {
    const types = Array.isArray(args.resourceTypes)
      ? (args.resourceTypes as unknown[]).map((t) => str(t))
      : [];
    return getResourceCounts(types, optStr(args.namespace));
  };

  const getResourceYamlHandler: Handler = async (args) => {
    return getResourceYaml(str(args.kind), str(args.name), str(args.namespace));
  };

  const getResourceHandler: Handler = async (args) => {
    return getResource(str(args.kind), str(args.name), str(args.namespace));
  };

  const getEventsHandler: Handler = async (args) => {
    return getEvents(optStr(args.namespace), optStr(args.fieldSelector));
  };

  const getResourceEventsHandler: Handler = async (args) => {
    return getResourceEvents(str(args.resourceType), str(args.name), str(args.namespace));
  };

  handlers.set('list_resources', listResourcesHandler);
  handlers.set('list_pods_by_selector', listPodsBySelectorHandler);
  handlers.set('get_resource_counts', getResourceCountsHandler);
  handlers.set('get_resource_yaml', getResourceYamlHandler);
  handlers.set('get_resource', getResourceHandler);
  handlers.set('get_events', getEventsHandler);
  handlers.set('get_resource_events', getResourceEventsHandler);
}
