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
import { metaFrom, listMetaFrom, listProjectionFor } from '../k8s/resource-mapping';
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
    wpa: ['datadoghq.com', 'v1alpha1', 'watermarkpodautoscalers', false],
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
export async function apiGet<T>(
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

async function listRaw(opts: ListOpts): Promise<{ items: RawObject[]; resourceVersion?: string }> {
  const { ar, namespace, labelSelector, paginate = true, accept } = opts;
  const path = resourcePath(ar, namespace);
  const items: RawObject[] = [];
  let cont: string | undefined;
  let resourceVersion: string | undefined;

  // Loop while there is a continue token (matches the Rust continue-token loop).
  for (;;) {
    const query: Record<string, string> = {};
    if (labelSelector) query.labelSelector = labelSelector;
    if (paginate) query.limit = String(LIST_PAGE_SIZE);
    if (cont) query.continue = cont;

    const list = await apiGet<RawList>(path, query, accept);
    if (list.items) items.push(...list.items);
    // Every page carries the SAME list resourceVersion (set at the first page);
    // keep the last non-empty one and hand it to the watch as its resume point.
    if (list.metadata?.resourceVersion) resourceVersion = list.metadata.resourceVersion;

    const token = list.metadata?.continue;
    if (!paginate || !token || token.length === 0) break;
    cont = token;
  }

  return { items, resourceVersion };
}

async function getRaw(ar: ApiResource, name: string, namespace: string): Promise<RawObject> {
  const base = resourcePath(ar, ar.clusterScoped ? undefined : namespace);
  return apiGet<RawObject>(`${base}/${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// list_resources
//
// Per-kind projections (pods lean projection, secrets, bindings, vpa, generic
// FieldSel table) live in electron/k8s/resource-mapping.ts — shared with the
// watch path so a watch event replaces a list row with the SAME lean shape.
// ---------------------------------------------------------------------------

async function listResources(resourceType: string, namespace?: string): Promise<ResourceList> {
  const ar = apiResourceForType(resourceType);
  const project = listProjectionFor(resourceType);
  if (!ar || !project) throw new Error(`Unknown resource type: ${resourceType}`);
  const { items: raw, resourceVersion } = await listRaw({ ar, namespace });
  const out: ResourceList = { items: raw.map(project), resource_type: resourceType };
  if (resourceVersion) out.resource_version = resourceVersion;
  return out;
}

// ---------------------------------------------------------------------------
// list_pods_by_selector
// ---------------------------------------------------------------------------

async function listPodsBySelector(namespace: string, selector: string): Promise<ResourceList> {
  const ar = apiResourceForType('pods')!;
  // Rust uses Api::namespaced/all with a label selector, single list (no paging).
  const { items: raw } = await listRaw({
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
      metadata: listMetaFrom(obj.metadata),
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
// Counts — port of counting.rs.
//
// Same trick as countCrd (crd.ts): ask for a single item and read
// `metadata.remainingItemCount`, so the apiserver does the counting and we
// never download (or even paginate) the actual listing. This runs for ~25
// kinds on every context/namespace switch (sidebar badges), so keeping each
// request to one tiny page is the dominant navigation win.
// ---------------------------------------------------------------------------

interface RawCountList {
  items?: unknown[];
  metadata?: { remainingItemCount?: number | null };
}

async function countResourceType(resourceType: string, namespace?: string): Promise<number> {
  const ar = apiResourceForType(resourceType);
  if (!ar) return 0; // Rust returns 0 for unknown/unsupported types.
  try {
    const list = await apiGet<RawCountList>(
      resourcePath(ar, namespace),
      { limit: '1' },
      META_ACCEPT,
    );
    const itemsLen = list.items?.length ?? 0;
    const remaining = list.metadata?.remainingItemCount;
    return remaining !== undefined && remaining !== null ? remaining + itemsLen : itemsLen;
  } catch {
    // 404 (e.g. the VPA CRD is not installed) or any other failure -> 0,
    // matching the Rust unwrap_or(0) path. No full-body retry.
    return 0;
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

// Cap event listings — busy clusters can hold tens of thousands of events, and
// the UI never renders anywhere near that many.
const EVENTS_LIMIT = 1000;

async function getEvents(namespace?: string, fieldSelector?: string): Promise<EventItem[]> {
  const core = getCoreV1Api();
  let list: RawEventList;
  if (namespace === undefined || namespace === null) {
    list = (await core.listEventForAllNamespaces({
      limit: EVENTS_LIMIT,
      ...(fieldSelector ? { fieldSelector } : {}),
    })) as RawEventList;
  } else {
    list = (await core.listNamespacedEvent({
      namespace,
      limit: EVENTS_LIMIT,
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
