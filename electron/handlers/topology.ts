// Topology handlers — the cluster relationship graph.
//
// Faithful port of src-tauri/src/k8s/topology/* (building.rs, extraction.rs,
// queries.rs, types.rs). The diagnostics half (diagnose_resource) lives in
// ./topology/diagnostics.ts; the shared JSON-coercion helpers in
// ./topology/shared.ts.
//
// Commands implemented here (EXACT Tauri command strings):
//   - get_namespace_topology  (args: { namespace?: string | null })
//   - get_resource_topology   (args: { uid: string, namespace?: string | null })
//   - diagnose_resource       (delegated to ./topology/diagnostics)
//
// Return SHAPES match the Rust serde output exactly. None of the Rust structs
// use #[serde(rename_all)], so every field is plain snake_case on the wire
// (api_version, is_ghost, controller_id, pod_count, pod_ids, edge_type,
// root_ids, has_cycles, total_resources, cluster_groups, ...). The Svelte types
// in src/lib/types/cluster.ts depend on exactly these names.

import type { HandlerCtx, HandlerMap } from '../dispatch';
import {
  getActiveContextName,
  getCoreV1Api,
  getAppsV1Api,
  getBatchV1Api,
  onConfigChange,
} from '../k8s/client';
import { apiGet, META_ACCEPT } from '../k8s/api';
import {
  asObject,
  asArray,
  asString,
  itemsOf,
  type JsonValue,
  type JsonObject,
} from './topology/shared';
import { diagnoseResource } from './topology/diagnostics';

// Diagnostic result types are owned by ./topology/diagnostics; re-export for any
// consumer that imports them from the topology entry point.
export type { DiagnosticIssue, DiagnosticResult } from './topology/diagnostics';

// ---------------------------------------------------------------------------
// Public wire types (match cluster.ts / src-tauri topology/types.rs)
// ---------------------------------------------------------------------------

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  namespace?: string;
  api_version: string;
  status?: string;
  is_ghost: boolean;
  depth: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  edge_type: string;
}

export interface ClusterGroup {
  controller_id: string;
  controller_kind: string;
  controller_name: string;
  pod_count: number;
  pod_ids: string[];
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  root_ids: string[];
  has_cycles: boolean;
  total_resources: number;
  clustered: boolean;
  cluster_groups: ClusterGroup[];
}

// ---------------------------------------------------------------------------
// Internal types (mirror RawResource / OwnerRef in topology/types.rs)
// ---------------------------------------------------------------------------

interface OwnerRef {
  uid: string;
  kind: string;
  name: string;
  api_version: string;
}

interface RawResource {
  uid: string;
  kind: string;
  name: string;
  namespace?: string;
  api_version: string;
  status?: string;
  owner_refs: OwnerRef[];
}

// ---------------------------------------------------------------------------
// Status extraction (port of extraction.rs::extract_status_str)
// ---------------------------------------------------------------------------

export function extractStatusStr(kind: string, obj: JsonObject): string | undefined {
  const status = asObject(obj['status']);
  if (!status) return undefined;

  switch (kind) {
    case 'Pod':
      return asString(status['phase']);
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet': {
      const conditions = asArray(status['conditions']);
      if (conditions) {
        for (const condRaw of conditions) {
          const cond = asObject(condRaw);
          if (!cond) continue;
          const ctype = asString(cond['type']) ?? '';
          const cstatus = asString(cond['status']) ?? '';
          if (ctype === 'Available') {
            return cstatus === 'True' ? 'Available' : 'Unavailable';
          }
        }
      }
      return 'Unknown';
    }
    case 'Job': {
      const conditions = asArray(status['conditions']);
      if (conditions) {
        for (const condRaw of conditions) {
          const cond = asObject(condRaw);
          if (!cond) continue;
          const ctype = asString(cond['type']) ?? '';
          const cstatus = asString(cond['status']) ?? '';
          if (ctype === 'Complete' && cstatus === 'True') return 'Complete';
          if (ctype === 'Failed' && cstatus === 'True') return 'Failed';
        }
      }
      return 'Running';
    }
    case 'Service': {
      const spec = asObject(obj['spec']);
      const svcType = spec ? asString(spec['type']) : undefined;
      return svcType;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Owner reference parsing (port of extraction.rs::parse_owner_refs)
// ---------------------------------------------------------------------------

function parseOwnerRefs(meta: JsonObject): OwnerRef[] {
  const refs = asArray(meta['ownerReferences']);
  if (!refs) return [];
  const out: OwnerRef[] = [];
  for (const rRaw of refs) {
    const r = asObject(rRaw);
    if (!r) continue;
    const uid = asString(r['uid']);
    const kind = asString(r['kind']);
    const name = asString(r['name']);
    // uid/kind/name are required (filter_map drops the ref if any is missing)
    if (uid === undefined || kind === undefined || name === undefined) continue;
    out.push({
      uid,
      kind,
      name,
      api_version: asString(r['apiVersion']) ?? '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dynamic -> RawResource conversion (port of extraction.rs::raw_from_dynamic)
// ---------------------------------------------------------------------------

export function rawFromDynamic(kind: string, apiVersion: string, items: JsonValue[]): RawResource[] {
  const out: RawResource[] = [];
  for (const itemRaw of items) {
    const obj = asObject(itemRaw);
    if (!obj) continue;
    const meta = asObject(obj['metadata']);
    if (!meta) continue;
    const uid = asString(meta['uid']);
    const name = asString(meta['name']);
    if (uid === undefined || name === undefined) continue; // required
    const namespace = asString(meta['namespace']);
    const ownerRefs = parseOwnerRefs(meta);
    const status = extractStatusStr(kind, obj);
    out.push({
      uid,
      kind,
      name,
      namespace,
      api_version: apiVersion,
      status,
      owner_refs: ownerRefs,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed list fetching (port of extraction.rs::fetch_typed! macro)
//
// Lists a typed resource (namespaced or all-namespaces), serializes each item to
// JSON, and converts via raw_from_dynamic. On error it returns an empty array
// (errors are swallowed per type so a single RBAC denial does not break the
// whole graph).
// ---------------------------------------------------------------------------

type ListFn = (namespace: string | null) => Promise<JsonValue[]>;

async function fetchTyped(
  list: ListFn,
  namespace: string | null,
  kind: string,
  apiVersion: string,
): Promise<RawResource[]> {
  try {
    const items = await list(namespace);
    return rawFromDynamic(kind, apiVersion, items);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Graph building (port of building.rs::build_graph)
// ---------------------------------------------------------------------------

export function buildGraph(resources: RawResource[], autoCluster: boolean): TopologyGraph {
  const totalResources = resources.length;
  const nodesMap = new Map<string, TopologyNode>();
  const edges: TopologyEdge[] = [];

  // Index all resources by UID
  for (const r of resources) {
    nodesMap.set(r.uid, {
      id: r.uid,
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      api_version: r.api_version,
      status: r.status,
      is_ghost: false,
      depth: 0,
    });
  }

  // Build edges from owner references (creating ghost nodes for missing owners)
  for (const r of resources) {
    for (const oref of r.owner_refs) {
      const ownerId = oref.uid;
      if (!nodesMap.has(ownerId)) {
        nodesMap.set(ownerId, {
          id: ownerId,
          kind: oref.kind,
          name: oref.name,
          namespace: r.namespace,
          api_version: oref.api_version,
          status: undefined,
          is_ghost: true,
          depth: 0,
        });
      }
      edges.push({ from: ownerId, to: r.uid, edge_type: 'owner' });
    }
  }

  // Cycle detection via DFS (mutates `edges`, removing back edges)
  const hasCycles = detectAndBreakCycles(nodesMap, edges);

  // Find roots (no incoming edges after cycle removal)
  const nodesWithParents = new Set<string>();
  for (const e of edges) nodesWithParents.add(e.to);
  const rootIds: string[] = [];
  for (const id of nodesMap.keys()) {
    if (!nodesWithParents.has(id)) rootIds.push(id);
  }

  // BFS to assign depth
  assignDepths(rootIds, edges, nodesMap);

  // Auto-clustering: group pods by controller when >200 nodes
  let clustered = false;
  let clusterGroups: ClusterGroup[] = [];
  if (autoCluster) {
    [clustered, clusterGroups] = extractPodClusters(nodesMap, edges);
  }

  const nodes: TopologyNode[] = Array.from(nodesMap.values());

  return {
    nodes,
    edges,
    root_ids: rootIds,
    has_cycles: hasCycles,
    total_resources: totalResources,
    clustered,
    cluster_groups: clusterGroups,
  };
}

// ---------------------------------------------------------------------------
// Cycle detection (port of building.rs::detect_and_break_cycles)
// ---------------------------------------------------------------------------

function detectAndBreakCycles(nodesMap: Map<string, TopologyNode>, edges: TopologyEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const arr = adj.get(e.from);
    if (arr) arr.push(e.to);
    else adj.set(e.from, [e.to]);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const backEdges: Array<[string, string]> = [];

  // Iterative DFS to avoid blowing the call stack on large graphs (the Rust
  // version recurses; node's default stack is shallower, so we emulate it).
  function dfs(start: string): void {
    // stack frames: [node, childIndex]
    const stack: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    visited.add(start);
    inStack.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = adj.get(frame.node);
      if (children && frame.i < children.length) {
        const child = children[frame.i]!;
        frame.i += 1;
        if (inStack.has(child)) {
          backEdges.push([frame.node, child]);
        } else if (!visited.has(child)) {
          visited.add(child);
          inStack.add(child);
          stack.push({ node: child, i: 0 });
        }
      } else {
        inStack.delete(frame.node);
        stack.pop();
      }
    }
  }

  for (const id of nodesMap.keys()) {
    if (!visited.has(id)) dfs(id);
  }

  if (backEdges.length > 0) {
    // Key with a separator that cannot occur in a k8s UID, so distinct edges
    // never collide (e.g. "x"+"yz" vs "xy"+"z"). add() and has() must match.
    const edgeKey = (from: string, to: string): string => `${from} ${to}`;
    const backSet = new Set<string>();
    for (const [a, b] of backEdges) backSet.add(edgeKey(a, b));
    // Retain edges that are NOT back edges (in place).
    let w = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      if (!backSet.has(edgeKey(e.from, e.to))) {
        edges[w++] = e;
      }
    }
    edges.length = w;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// BFS depth assignment (port of building.rs::assign_depths)
// ---------------------------------------------------------------------------

function assignDepths(
  rootIds: string[],
  edges: TopologyEdge[],
  nodesMap: Map<string, TopologyNode>,
): void {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const arr = adj.get(e.from);
    if (arr) arr.push(e.to);
    else adj.set(e.from, [e.to]);
  }

  const queue: string[] = [];
  const visited = new Set<string>();

  for (const root of rootIds) {
    queue.push(root);
    visited.add(root);
    const node = nodesMap.get(root);
    if (node) node.depth = 0;
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const currentDepth = nodesMap.get(current)?.depth ?? 0;
    const children = adj.get(current);
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child);
          const node = nodesMap.get(child);
          if (node) node.depth = currentDepth + 1;
          queue.push(child);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pod clustering (port of building.rs::extract_pod_clusters)
//
// Groups pods by their controller when node count exceeds 200. Mutates
// nodesMap/edges in place by removing clustered pod nodes and their edges.
// Only controllers with >3 pods are clustered.
// ---------------------------------------------------------------------------

function extractPodClusters(
  nodesMap: Map<string, TopologyNode>,
  edges: TopologyEdge[],
): [boolean, ClusterGroup[]] {
  if (nodesMap.size <= 200) {
    return [false, []];
  }

  const clusterGroups: ClusterGroup[] = [];

  // Group pods by their owner (controller)
  const controllerPods = new Map<string, string[]>();
  for (const e of edges) {
    const childNode = nodesMap.get(e.to);
    if (childNode && childNode.kind === 'Pod') {
      const arr = controllerPods.get(e.from);
      if (arr) arr.push(e.to);
      else controllerPods.set(e.from, [e.to]);
    }
  }

  // Create cluster groups for controllers with >3 pods
  const removeIds = new Set<string>();
  for (const [controllerId, podIds] of controllerPods) {
    if (podIds.length > 3) {
      const controller = nodesMap.get(controllerId);
      clusterGroups.push({
        controller_id: controllerId,
        controller_kind: controller?.kind ?? '',
        controller_name: controller?.name ?? '',
        pod_count: podIds.length,
        pod_ids: podIds.slice(),
      });
      for (const pid of podIds) removeIds.add(pid);
    }
  }

  // Remove clustered pods from nodes and edges
  for (const id of removeIds) nodesMap.delete(id);
  let w = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (!removeIds.has(e.to)) edges[w++] = e;
  }
  edges.length = w;

  return [true, clusterGroups];
}

// ---------------------------------------------------------------------------
// queries.rs::get_namespace_topology
//
// The full namespace graph (12 list calls) is cached briefly per
// context+namespace: opening a resource detail calls get_resource_topology,
// which only needs to extract a subgraph — without the cache every detail
// open re-issued all 12 lists. TTL-based invalidation is enough here; the key
// embeds the active context so a context switch never serves stale data.
// ---------------------------------------------------------------------------

const TOPOLOGY_CACHE_TTL_MS = 15_000;

interface TopologyCacheEntry {
  at: number;
  promise: Promise<TopologyGraph>;
}

/** Bounded: each entry pins a full graph; without a cap the map grows with
 * every namespace/context ever visited and the stale graphs are never GC'd. */
const TOPOLOGY_CACHE_MAX_ENTRIES = 8;

const topologyCache = new Map<string, TopologyCacheEntry>();

// A context switch invalidates everything (keys embed the context, but stale
// graphs for other contexts would otherwise sit in memory indefinitely).
onConfigChange(() => topologyCache.clear());

async function getNamespaceTopology(namespace: string | null): Promise<TopologyGraph> {
  const key = `${getActiveContextName() ?? ''}|${namespace ?? ''}`;
  const now = Date.now();
  const hit = topologyCache.get(key);
  if (hit && now - hit.at < TOPOLOGY_CACHE_TTL_MS) return hit.promise;

  // Evict expired entries, then the oldest if still at capacity.
  for (const [k, v] of topologyCache) {
    if (now - v.at >= TOPOLOGY_CACHE_TTL_MS) topologyCache.delete(k);
  }
  while (topologyCache.size >= TOPOLOGY_CACHE_MAX_ENTRIES) {
    const oldest = topologyCache.keys().next().value;
    if (oldest === undefined) break;
    topologyCache.delete(oldest);
  }

  const promise = fetchNamespaceTopology(namespace);
  topologyCache.set(key, { at: now, promise });
  // Never cache failures — the next call retries.
  promise.catch(() => {
    if (topologyCache.get(key)?.promise === promise) topologyCache.delete(key);
  });
  return promise;
}

/**
 * Metadata-only list via content negotiation. Kinds whose graph node needs no
 * status/spec field (see extractStatusStr) fetch a PartialObjectMetadataList —
 * uid/name/namespace/ownerReferences are all in metadata, and the payload is a
 * tiny fraction of the full body (listing every Secret/ConfigMap cluster-wide
 * with full bodies was the dominant cost of building the graph). The Accept
 * header falls back to a normal list server-side if the kind doesn't support
 * the projection.
 */
async function listMeta(group: string, version: string, plural: string, ns: string | null): Promise<JsonValue[]> {
  const base = group === '' ? `/api/${version}` : `/apis/${group}/${version}`;
  const path = ns
    ? `${base}/namespaces/${encodeURIComponent(ns)}/${plural}`
    : `${base}/${plural}`;
  const list = await apiGet<{ items?: JsonValue[] }>(path, undefined, META_ACCEPT);
  return list.items ?? [];
}

async function fetchNamespaceTopology(namespace: string | null): Promise<TopologyGraph> {
  const core = getCoreV1Api();
  const apps = getAppsV1Api();
  const batch = getBatchV1Api();

  // Each entry mirrors one fetch_typed! arm in queries.rs (kind + apiVersion +
  // namespaced/all-namespaces list fn). Kinds needing a status/spec field keep
  // the typed full-body list; the rest go metadata-only (listMeta above).
  const fetches: Array<Promise<RawResource[]>> = [
    fetchTyped(
      (ns) =>
        ns
          ? core.listNamespacedPod({ namespace: ns }).then(itemsOf)
          : core.listPodForAllNamespaces().then(itemsOf),
      namespace,
      'Pod',
      'v1',
    ),
    fetchTyped(
      (ns) =>
        ns
          ? apps.listNamespacedDeployment({ namespace: ns }).then(itemsOf)
          : apps.listDeploymentForAllNamespaces().then(itemsOf),
      namespace,
      'Deployment',
      'apps/v1',
    ),
    fetchTyped((ns) => listMeta('apps', 'v1', 'replicasets', ns), namespace, 'ReplicaSet', 'apps/v1'),
    fetchTyped(
      (ns) =>
        ns
          ? apps.listNamespacedStatefulSet({ namespace: ns }).then(itemsOf)
          : apps.listStatefulSetForAllNamespaces().then(itemsOf),
      namespace,
      'StatefulSet',
      'apps/v1',
    ),
    fetchTyped(
      (ns) =>
        ns
          ? apps.listNamespacedDaemonSet({ namespace: ns }).then(itemsOf)
          : apps.listDaemonSetForAllNamespaces().then(itemsOf),
      namespace,
      'DaemonSet',
      'apps/v1',
    ),
    fetchTyped(
      (ns) =>
        ns
          ? batch.listNamespacedJob({ namespace: ns }).then(itemsOf)
          : batch.listJobForAllNamespaces().then(itemsOf),
      namespace,
      'Job',
      'batch/v1',
    ),
    fetchTyped((ns) => listMeta('batch', 'v1', 'cronjobs', ns), namespace, 'CronJob', 'batch/v1'),
    fetchTyped(
      (ns) =>
        ns
          ? core.listNamespacedService({ namespace: ns }).then(itemsOf)
          : core.listServiceForAllNamespaces().then(itemsOf),
      namespace,
      'Service',
      'v1',
    ),
    fetchTyped(
      (ns) => listMeta('networking.k8s.io', 'v1', 'ingresses', ns),
      namespace,
      'Ingress',
      'networking.k8s.io/v1',
    ),
    fetchTyped((ns) => listMeta('', 'v1', 'configmaps', ns), namespace, 'ConfigMap', 'v1'),
    fetchTyped((ns) => listMeta('', 'v1', 'secrets', ns), namespace, 'Secret', 'v1'),
    fetchTyped(
      (ns) => listMeta('autoscaling', 'v2', 'horizontalpodautoscalers', ns),
      namespace,
      'HorizontalPodAutoscaler',
      'autoscaling/v2',
    ),
  ];

  const results = await Promise.all(fetches);
  const all: RawResource[] = [];
  for (const r of results) all.push(...r);

  return buildGraph(all, true);
}

// ---------------------------------------------------------------------------
// queries.rs::get_resource_topology
// ---------------------------------------------------------------------------

async function getResourceTopology(uid: string, namespace: string | null): Promise<TopologyGraph> {
  const full = await getNamespaceTopology(namespace);

  // Build adjacency
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const e of full.edges) {
    const c = childrenOf.get(e.from);
    if (c) c.push(e.to);
    else childrenOf.set(e.from, [e.to]);
    const p = parentsOf.get(e.to);
    if (p) p.push(e.from);
    else parentsOf.set(e.to, [e.from]);
  }

  const included = new Set<string>();

  if (full.nodes.some((n) => n.id === uid)) {
    included.add(uid);

    // Walk up to ancestors
    const upQueue: string[] = [uid];
    let uh = 0;
    while (uh < upQueue.length) {
      const current = upQueue[uh++]!;
      const parents = parentsOf.get(current);
      if (parents) {
        for (const p of parents) {
          if (!included.has(p)) {
            included.add(p);
            upQueue.push(p);
          }
        }
      }
    }

    // Walk down to descendants
    const queue: string[] = [uid];
    let dh = 0;
    while (dh < queue.length) {
      const current = queue[dh++]!;
      const children = childrenOf.get(current);
      if (children) {
        for (const c of children) {
          if (!included.has(c)) {
            included.add(c);
            queue.push(c);
          }
        }
      }
    }
  }

  const nodes = full.nodes.filter((n) => included.has(n.id));
  const edges = full.edges.filter((e) => included.has(e.from) && included.has(e.to));
  const rootIds = full.root_ids.filter((id) => included.has(id));

  return {
    nodes,
    edges,
    root_ids: rootIds,
    has_cycles: full.has_cycles,
    total_resources: included.size,
    clustered: false,
    cluster_groups: [],
  };
}

// ---------------------------------------------------------------------------
// Error normalization — mirror Result<_, String> (the shim rejects with the
// message). client-node throws ApiException; surface a readable message.
// ---------------------------------------------------------------------------

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  void _ctx;

  handlers.set('get_namespace_topology', async (args) => {
    const namespace = (args['namespace'] as string | null | undefined) ?? null;
    try {
      return await getNamespaceTopology(namespace);
    } catch (err) {
      throw new Error(toErrorMessage(err));
    }
  });

  handlers.set('get_resource_topology', async (args) => {
    const uid = args['uid'];
    if (typeof uid !== 'string') {
      throw new Error('get_resource_topology: missing required arg "uid"');
    }
    const namespace = (args['namespace'] as string | null | undefined) ?? null;
    try {
      return await getResourceTopology(uid, namespace);
    } catch (err) {
      throw new Error(toErrorMessage(err));
    }
  });

  handlers.set('diagnose_resource', async (args) => {
    const kind = args['kind'];
    const name = args['name'];
    const namespace = args['namespace'];
    if (typeof kind !== 'string' || typeof name !== 'string' || typeof namespace !== 'string') {
      throw new Error('diagnose_resource: requires string args "kind", "name", "namespace"');
    }
    try {
      return await diagnoseResource(kind, name, namespace);
    } catch (err) {
      throw new Error(toErrorMessage(err));
    }
  });
}
