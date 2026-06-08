// Topology + diagnostics handlers.
//
// Faithful port of src-tauri/src/k8s/topology/* (building.rs, extraction.rs,
// queries.rs, types.rs) and src-tauri/src/k8s/diagnostics/* (pod.rs,
// workload.rs, aggregation.rs, types.rs).
//
// Commands implemented here (EXACT Tauri command strings):
//   - get_namespace_topology  (args: { namespace?: string | null })
//   - get_resource_topology   (args: { uid: string, namespace?: string | null })
//   - diagnose_resource       (args: { kind: string, name: string, namespace: string })
//
// Return SHAPES match the Rust serde output exactly. None of the Rust structs
// use #[serde(rename_all)], so every field is plain snake_case on the wire
// (api_version, is_ghost, controller_id, pod_count, pod_ids, edge_type,
// root_ids, has_cycles, total_resources, cluster_groups, resource_uid,
// resource_kind, resource_name, checked_at, ...). The Svelte types in
// src/lib/types/cluster.ts depend on exactly these names.

import type { HandlerCtx, HandlerMap } from '../dispatch';
import {
  getCoreV1Api,
  getAppsV1Api,
  getBatchV1Api,
  getNetworkingV1Api,
  makeApiClient,
} from '../k8s/client';
import { AutoscalingV2Api } from '@kubernetes/client-node';

// ---------------------------------------------------------------------------
// Public wire types (match cluster.ts / src-tauri topology+diagnostics types.rs)
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

export interface DiagnosticIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
  suggestion: string;
}

export interface DiagnosticResult {
  resource_uid: string;
  resource_kind: string;
  resource_name: string;
  health: 'healthy' | 'degraded' | 'unhealthy';
  issues: DiagnosticIssue[];
  checked_at: string;
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

/** Loose JSON object alias — k8s list items are serialized to plain JSON, as in
 *  the Rust port (serde_json::Value). */
type JsonValue = unknown;
type JsonObject = Record<string, JsonValue>;

function asObject(v: JsonValue): JsonObject | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;
}
function asArray(v: JsonValue): JsonValue[] | undefined {
  return Array.isArray(v) ? (v as JsonValue[]) : undefined;
}
function asString(v: JsonValue): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asBool(v: JsonValue): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function asNumber(v: JsonValue): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Status extraction (port of extraction.rs::extract_status_str)
// ---------------------------------------------------------------------------

function extractStatusStr(kind: string, obj: JsonObject): string | undefined {
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

function rawFromDynamic(kind: string, apiVersion: string, items: JsonValue[]): RawResource[] {
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
// The Rust macro lists a typed resource (namespaced or all-namespaces),
// serializes each item to JSON, and converts via raw_from_dynamic. On error it
// returns an empty Vec (errors are swallowed per type so a single RBAC denial
// does not break the whole graph).
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

/** Extract the `.items` array from a client-node list response as plain JSON. */
function itemsOf(resp: unknown): JsonValue[] {
  const obj = asObject(resp);
  if (!obj) return [];
  const items = asArray(obj['items']);
  return items ?? [];
}

// ---------------------------------------------------------------------------
// Graph building (port of building.rs::build_graph)
// ---------------------------------------------------------------------------

function buildGraph(resources: RawResource[], autoCluster: boolean): TopologyGraph {
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
    const backSet = new Set<string>();
    for (const [a, b] of backEdges) backSet.add(`${a} ${b}`);
    // Retain edges that are NOT back edges (in place).
    let w = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      if (!backSet.has(`${e.from} ${e.to}`)) {
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
// ---------------------------------------------------------------------------

async function getNamespaceTopology(namespace: string | null): Promise<TopologyGraph> {
  const core = getCoreV1Api();
  const apps = getAppsV1Api();
  const batch = getBatchV1Api();
  const net = getNetworkingV1Api();
  const autoscaling = makeApiClient(AutoscalingV2Api);

  // Each entry mirrors one fetch_typed! arm in queries.rs (kind + apiVersion +
  // namespaced/all-namespaces list fn).
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
    fetchTyped(
      (ns) =>
        ns
          ? apps.listNamespacedReplicaSet({ namespace: ns }).then(itemsOf)
          : apps.listReplicaSetForAllNamespaces().then(itemsOf),
      namespace,
      'ReplicaSet',
      'apps/v1',
    ),
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
    fetchTyped(
      (ns) =>
        ns
          ? batch.listNamespacedCronJob({ namespace: ns }).then(itemsOf)
          : batch.listCronJobForAllNamespaces().then(itemsOf),
      namespace,
      'CronJob',
      'batch/v1',
    ),
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
      (ns) =>
        ns
          ? net.listNamespacedIngress({ namespace: ns }).then(itemsOf)
          : net.listIngressForAllNamespaces().then(itemsOf),
      namespace,
      'Ingress',
      'networking.k8s.io/v1',
    ),
    fetchTyped(
      (ns) =>
        ns
          ? core.listNamespacedConfigMap({ namespace: ns }).then(itemsOf)
          : core.listConfigMapForAllNamespaces().then(itemsOf),
      namespace,
      'ConfigMap',
      'v1',
    ),
    fetchTyped(
      (ns) =>
        ns
          ? core.listNamespacedSecret({ namespace: ns }).then(itemsOf)
          : core.listSecretForAllNamespaces().then(itemsOf),
      namespace,
      'Secret',
      'v1',
    ),
    fetchTyped(
      (ns) =>
        ns
          ? autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace: ns }).then(itemsOf)
          : autoscaling.listHorizontalPodAutoscalerForAllNamespaces().then(itemsOf),
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
// Diagnostics — pod.rs::diagnose_pod
// ---------------------------------------------------------------------------

function diagnosePod(obj: JsonObject): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const status = asObject(obj['status']);
  if (!status) return issues;

  const phase = asString(status['phase']) ?? '';

  const containerStatuses = asArray(status['containerStatuses']);
  if (containerStatuses) {
    for (const csRaw of containerStatuses) {
      const cs = asObject(csRaw);
      if (!cs) continue;
      const containerName = asString(cs['name']) ?? 'unknown';
      const restartCount = asNumber(cs['restartCount']) ?? 0;

      const state = asObject(cs['state']);

      // CrashLoopBackOff / ImagePullBackOff / CreateContainerConfigError (waiting)
      const waiting = state ? asObject(state['waiting']) : undefined;
      if (waiting) {
        const reason = asString(waiting['reason']) ?? '';
        const message = asString(waiting['message']) ?? '';

        if (reason === 'CrashLoopBackOff') {
          issues.push({
            severity: 'critical',
            category: 'crash',
            title: `Container '${containerName}' is in CrashLoopBackOff`,
            detail: `Restarts: ${restartCount}. ${message}`,
            suggestion:
              'Check container logs for the crash cause. Common causes: missing env vars, wrong command, config errors.',
          });
        }

        if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') {
          const image = asString(cs['image']) ?? 'unknown';
          issues.push({
            severity: 'critical',
            category: 'image',
            title: `Container '${containerName}' cannot pull image`,
            detail: `Image: ${image}. ${message}`,
            suggestion:
              'Verify image name/tag exists, check registry credentials (imagePullSecrets), and ensure network access to registry.',
          });
        }

        if (reason === 'CreateContainerConfigError') {
          issues.push({
            severity: 'critical',
            category: 'crash',
            title: `Container '${containerName}' has a config error`,
            detail: message,
            suggestion:
              'Check referenced ConfigMaps, Secrets, and volume mounts exist and are accessible.',
          });
        }
      }

      // OOMKilled — last terminated state
      const lastState = asObject(cs['lastState']);
      const lastTerminated = lastState ? asObject(lastState['terminated']) : undefined;
      if (lastTerminated) {
        const reason = asString(lastTerminated['reason']) ?? '';
        if (reason === 'OOMKilled') {
          issues.push({
            severity: 'critical',
            category: 'oom',
            title: `Container '${containerName}' was OOMKilled`,
            detail: `The container exceeded its memory limit and was killed. Restarts: ${restartCount}`,
            suggestion:
              "Increase memory limits in the pod spec, or investigate the application's memory usage for leaks.",
          });
        }
      }

      // OOMKilled — current terminated state
      const currTerminated = state ? asObject(state['terminated']) : undefined;
      if (currTerminated) {
        const reason = asString(currTerminated['reason']) ?? '';
        if (reason === 'OOMKilled') {
          issues.push({
            severity: 'critical',
            category: 'oom',
            title: `Container '${containerName}' is currently OOMKilled`,
            detail: 'The container ran out of memory.',
            suggestion: "Increase memory limits or optimize the application's memory usage.",
          });
        }
      }

      // High restart count
      if (restartCount > 5) {
        issues.push({
          severity: 'warning',
          category: 'crash',
          title: `Container '${containerName}' has ${restartCount} restarts`,
          detail: 'Frequent restarts indicate instability.',
          suggestion:
            'Check logs across restarts (use --previous flag) to identify the recurring failure pattern.',
        });
      }

      // Not ready (running but not ready)
      const ready = asBool(cs['ready']) ?? false;
      const running = state ? asObject(state['running']) : undefined;
      if (!ready && running !== undefined) {
        issues.push({
          severity: 'warning',
          category: 'readiness',
          title: `Container '${containerName}' is running but not ready`,
          detail: 'The readiness probe is failing.',
          suggestion:
            "Check readiness probe configuration and the application's health endpoint.",
        });
      }
    }
  }

  // Conditions — unschedulable
  const conditions = asArray(status['conditions']);
  if (conditions) {
    for (const condRaw of conditions) {
      const cond = asObject(condRaw);
      if (!cond) continue;
      const ctype = asString(cond['type']) ?? '';
      const cstatus = asString(cond['status']) ?? '';
      const reason = asString(cond['reason']) ?? '';
      const message = asString(cond['message']) ?? '';

      if (ctype === 'PodScheduled' && cstatus === 'False') {
        issues.push({
          severity: 'critical',
          category: 'scheduling',
          title: 'Pod cannot be scheduled',
          detail: `${reason}: ${message}`,
          suggestion:
            'Check node resources (CPU/memory availability), node taints/tolerations, and affinity rules.',
        });
      }
    }
  }

  // Pending phase (only if no other issues)
  if (phase === 'Pending' && issues.length === 0) {
    issues.push({
      severity: 'warning',
      category: 'scheduling',
      title: 'Pod is in Pending state',
      detail: 'The pod has not been scheduled yet.',
      suggestion:
        'Check events for scheduling details, verify resource availability and node capacity.',
    });
  }

  // Missing resource limits
  const spec = asObject(obj['spec']);
  const containers = spec ? asArray(spec['containers']) : undefined;
  if (containers) {
    for (const containerRaw of containers) {
      const container = asObject(containerRaw);
      if (!container) continue;
      const name = asString(container['name']) ?? 'unknown';
      const resources = asObject(container['resources']);
      const limits = resources ? asObject(resources['limits']) : undefined;
      const hasLimits = limits !== undefined && Object.keys(limits).length > 0;

      if (!hasLimits) {
        issues.push({
          severity: 'info',
          category: 'resources',
          title: `Container '${name}' has no resource limits`,
          detail: 'Without resource limits, the container can consume unbounded resources.',
          suggestion: 'Set memory and CPU limits to prevent resource contention and OOM kills.',
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Diagnostics — workload.rs::diagnose_deployment
// ---------------------------------------------------------------------------

function diagnoseDeployment(obj: JsonObject): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const status = asObject(obj['status']);
  if (!status) return issues;

  const conditions = asArray(status['conditions']);
  if (conditions) {
    for (const condRaw of conditions) {
      const cond = asObject(condRaw);
      if (!cond) continue;
      const ctype = asString(cond['type']) ?? '';
      const cstatus = asString(cond['status']) ?? '';
      const reason = asString(cond['reason']) ?? '';
      const message = asString(cond['message']) ?? '';

      if (ctype === 'Progressing' && cstatus === 'False' && reason === 'ProgressDeadlineExceeded') {
        issues.push({
          severity: 'critical',
          category: 'crash',
          title: 'Deployment progress deadline exceeded',
          detail: message,
          suggestion:
            'The rollout is stuck. Check pod events and logs for the failing pods. Consider rolling back.',
        });
      }

      if (ctype === 'Available' && cstatus === 'False') {
        issues.push({
          severity: 'critical',
          category: 'readiness',
          title: 'Deployment has no available replicas',
          detail: message,
          suggestion:
            'Check the pods managed by this deployment for crash loops or scheduling issues.',
        });
      }
    }
  }

  // Replica mismatch
  const spec = asObject(obj['spec']);
  const desired = (spec ? asNumber(spec['replicas']) : undefined) ?? 0;
  const ready = asNumber(status['readyReplicas']) ?? 0;
  if (desired > 0 && ready < desired) {
    issues.push({
      severity: 'warning',
      category: 'readiness',
      title: `Only ${ready}/${desired} replicas ready`,
      detail: 'Not all desired replicas are ready.',
      suggestion: 'Check individual pods for issues. A rollout may be in progress.',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Diagnostics — minimal event fetch for the diagnose path
//
// Port of the subset of resources::get_resource_events used by aggregation.rs:
// only reason / message / type_ / count are read. Self-contained here so the
// topology module does not depend on the resources group.
// ---------------------------------------------------------------------------

interface MinimalEvent {
  reason?: string;
  message?: string;
  type_?: string;
  count?: number;
}

const RESOURCE_TYPE_TO_KIND: Record<string, string> = {
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
): Promise<MinimalEvent[]> {
  const kind = RESOURCE_TYPE_TO_KIND[resourceType] ?? resourceType;
  const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${kind}`;
  const core = getCoreV1Api();

  const resp = namespace
    ? await core.listNamespacedEvent({ namespace, fieldSelector })
    : await core.listEventForAllNamespaces({ fieldSelector });

  const items = itemsOf(resp);
  const out: MinimalEvent[] = [];
  for (const itemRaw of items) {
    const e = asObject(itemRaw);
    if (!e) continue;
    out.push({
      reason: asString(e['reason']),
      message: asString(e['message']),
      // k8s-openapi/serde maps the JSON field "type" to type_ in Rust; on the
      // wire the K8s Event JSON field is "type".
      type_: asString(e['type']),
      count: asNumber(e['count']),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostics — aggregation.rs::diagnose_resource
// ---------------------------------------------------------------------------

/** Read a single namespaced resource as plain JSON, mapping kind -> reader. */
async function readResource(
  kindLower: string,
  name: string,
  namespace: string,
): Promise<JsonObject> {
  const core = getCoreV1Api();
  const apps = getAppsV1Api();
  const batch = getBatchV1Api();

  let resp: unknown;
  switch (kindLower) {
    case 'pod':
      resp = await core.readNamespacedPod({ name, namespace });
      break;
    case 'deployment':
      resp = await apps.readNamespacedDeployment({ name, namespace });
      break;
    case 'statefulset':
      resp = await apps.readNamespacedStatefulSet({ name, namespace });
      break;
    case 'daemonset':
      resp = await apps.readNamespacedDaemonSet({ name, namespace });
      break;
    case 'job':
      resp = await batch.readNamespacedJob({ name, namespace });
      break;
    case 'replicaset':
      resp = await apps.readNamespacedReplicaSet({ name, namespace });
      break;
    default:
      // Rust falls back to reading a Pod for unknown kinds.
      resp = await core.readNamespacedPod({ name, namespace });
      break;
  }
  const obj = asObject(resp);
  if (!obj) {
    throw new Error(`Failed to read ${kindLower}/${name}`);
  }
  return obj;
}

/** Map plural resource_type used for event lookup, mirroring the Rust match. */
function resourceTypeForKind(kindLower: string): string {
  switch (kindLower) {
    case 'pod':
      return 'pods';
    case 'deployment':
      return 'deployments';
    case 'statefulset':
      return 'statefulsets';
    case 'daemonset':
      return 'daemonsets';
    case 'job':
      return 'jobs';
    case 'replicaset':
      return 'replicasets';
    default:
      return 'pods';
  }
}

async function diagnoseResource(
  kind: string,
  name: string,
  namespace: string,
): Promise<DiagnosticResult> {
  const now = new Date().toISOString();
  const kindLower = kind.toLowerCase();

  const obj = await readResource(kindLower, name, namespace);

  const meta = asObject(obj['metadata']);
  const uid = (meta ? asString(meta['uid']) : undefined) ?? '';

  // Run diagnostics based on kind
  let issues: DiagnosticIssue[];
  switch (kindLower) {
    case 'pod':
      issues = diagnosePod(obj);
      break;
    case 'deployment':
    case 'statefulset':
    case 'daemonset':
      issues = diagnoseDeployment(obj);
      break;
    default:
      issues = [];
      break;
  }

  // Check events for additional signals (errors swallowed, as in Rust's if-let-Ok)
  try {
    const resourceType = resourceTypeForKind(kindLower);
    const events = await getResourceEvents(resourceType, name, namespace);
    for (const event of events) {
      if (event.type_ === 'Warning') {
        const reason = event.reason ?? '';
        const message = event.message ?? '';
        const count = event.count ?? 1;

        if (count >= 3) {
          const alreadyCovered = issues.some(
            (i) => (reason !== '' && i.title.includes(reason)) || (reason !== '' && i.detail.includes(reason)),
          );
          if (!alreadyCovered) {
            issues.push({
              severity: 'warning',
              category: 'crash',
              title: `Repeated warning event: ${reason}`,
              detail: `${message}. Occurred ${count} times.`,
              suggestion: 'Investigate the event details and related logs.',
            });
          }
        }
      }
    }
  } catch {
    // ignore — events are best-effort
  }

  const health: DiagnosticResult['health'] = issues.some((i) => i.severity === 'critical')
    ? 'unhealthy'
    : issues.some((i) => i.severity === 'warning')
      ? 'degraded'
      : 'healthy';

  return {
    resource_uid: uid,
    resource_kind: kind,
    resource_name: name,
    health,
    issues,
    checked_at: now,
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
