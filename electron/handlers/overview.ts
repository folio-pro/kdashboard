// Cluster overview handler — one command that feeds the Overview and Problems
// views: nodes with requests/usage, pod phase counts, every current problem
// (nodes, workloads, pods, stuck PVCs, Services without endpoints or without a
// LoadBalancer address), the last hour of Warning events and the top pods by
// usage.
//
// Commands:
//   - get_cluster_overview  { namespace?: string | null }
//
// Lists are cluster-wide when allowed; a kind whose cluster-wide list is
// refused (403 under namespace-scoped RBAC) is re-listed in `namespace`, and
// anything that still fails is reported in `partial` rather than failing the
// whole command. The judging lives in electron/k8s/overview.ts.

import type {
  CoreV1Event,
  V1DaemonSet,
  V1Deployment,
  V1Endpoints,
  V1Job,
  V1Node,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node';

import { optStr, type HandlerCtx, type HandlerMap } from '../dispatch';
import { getActiveContextName, getAppsV1Api, getBatchV1Api, getCoreV1Api, onConfigChange } from '../k8s/client';
import { listScoped } from '../k8s/list-scope';
import { nodeUsage as readNodeUsage, podUsageScoped, type NodeUsage } from '../k8s/metrics-source';
import { createTtlCache } from '../util/ttl-cache';
import {
  foldPodsIntoOwners,
  nodeProblems,
  orderProblems,
  podPhaseCounts,
  podProblems,
  pvcProblems,
  recentWarnings,
  serviceProblems,
  summarizeNodes,
  workloadProblems,
  type ClusterOverview,
  type TopPod,
} from '../k8s/overview';

const WARNING_WINDOW_MS = 60 * 60_000;
const TOP_PODS = 8;

async function nodeUsage(): Promise<Map<string, NodeUsage> | null> {
  try {
    return await readNodeUsage();
  } catch {
    return null;
  }
}

async function topPods(namespace: string | null): Promise<{ cpu: TopPod[]; memory: TopPod[] } | null> {
  try {
    const rows: TopPod[] = (await podUsageScoped(namespace)).map((p) => ({
      name: p.name,
      namespace: p.namespace,
      cpu_usage: p.cpu_cores,
      memory_usage: p.memory_bytes,
    }));
    return {
      cpu: [...rows].sort((a, b) => b.cpu_usage - a.cpu_usage).slice(0, TOP_PODS),
      memory: [...rows].sort((a, b) => b.memory_usage - a.memory_usage).slice(0, TOP_PODS),
    };
  } catch {
    return null;
  }
}

export async function getClusterOverview(namespace: string | null): Promise<ClusterOverview> {
  const core = getCoreV1Api();
  const apps = getAppsV1Api();
  const batch = getBatchV1Api();

  const [nodes, pods, deployments, statefulsets, daemonsets, jobs, pvcs, services, endpoints, events, usage, top] = await Promise.all([
    listScoped<V1Node>(() => core.listNode(), null, null),
    listScoped<V1Pod>(() => core.listPodForAllNamespaces(), (ns) => core.listNamespacedPod({ namespace: ns }), namespace),
    listScoped<V1Deployment>(() => apps.listDeploymentForAllNamespaces(), (ns) => apps.listNamespacedDeployment({ namespace: ns }), namespace),
    listScoped<V1StatefulSet>(() => apps.listStatefulSetForAllNamespaces(), (ns) => apps.listNamespacedStatefulSet({ namespace: ns }), namespace),
    listScoped<V1DaemonSet>(() => apps.listDaemonSetForAllNamespaces(), (ns) => apps.listNamespacedDaemonSet({ namespace: ns }), namespace),
    listScoped<V1Job>(() => batch.listJobForAllNamespaces(), (ns) => batch.listNamespacedJob({ namespace: ns }), namespace),
    listScoped<V1PersistentVolumeClaim>(() => core.listPersistentVolumeClaimForAllNamespaces(), (ns) => core.listNamespacedPersistentVolumeClaim({ namespace: ns }), namespace),
    listScoped<V1Service>(() => core.listServiceForAllNamespaces(), (ns) => core.listNamespacedService({ namespace: ns }), namespace),
    listScoped<V1Endpoints>(() => core.listEndpointsForAllNamespaces(), (ns) => core.listNamespacedEndpoints({ namespace: ns }), namespace),
    listScoped<CoreV1Event>(
      () => core.listEventForAllNamespaces({ fieldSelector: 'type=Warning' }),
      (ns) => core.listNamespacedEvent({ namespace: ns, fieldSelector: 'type=Warning' }),
      namespace,
    ),
    nodeUsage(),
    topPods(namespace),
  ]);

  const partial: string[] = [];
  const scopes = { nodes, pods, deployments, statefulsets, daemonsets, jobs, persistentvolumeclaims: pvcs, services, endpoints, events };
  for (const [kind, listed] of Object.entries(scopes)) if (listed.scope === null) partial.push(kind);
  // The scope is what was asked for: `listScoped` lists cluster-wide exactly
  // when no namespace was given. Deriving it from the lists' own scopes
  // mislabelled a cluster-wide request as "namespace" (with namespace: null)
  // whenever every namespaced list failed; `partial` already says which did.
  const scope: ClusterOverview['scope'] = namespace === null ? 'cluster' : 'namespace';

  const nodeRows = summarizeNodes(nodes.items, pods.scope === null ? null : pods.items, usage);
  const problems = orderProblems(
    foldPodsIntoOwners([
      ...nodeProblems(nodeRows),
      ...workloadProblems({ deployments: deployments.items, statefulsets: statefulsets.items, daemonsets: daemonsets.items, jobs: jobs.items }, pods.items),
      ...podProblems(pods.items),
      ...pvcProblems(pvcs.items, events.items),
      ...serviceProblems(services.items, endpoints.scope === null ? null : endpoints.items),
    ]),
  );
  const warnings = recentWarnings(events.items, Date.now() - WARNING_WINDOW_MS);

  return {
    scope,
    namespace: scope === 'namespace' ? namespace : null,
    nodes: nodeRows,
    pods: podPhaseCounts(pods.items),
    problems,
    warnings: warnings.items,
    warnings_total: warnings.total,
    top_pods_cpu: top?.cpu ?? [],
    top_pods_memory: top?.memory ?? [],
    metrics_available: usage !== null || top !== null,
    partial,
    fetched_at: new Date().toISOString(),
  };
}

// Short TTL + single-flight: Overview and Problems share this payload, and
// hopping between them (or two tabs mounting at once) re-listed every pod,
// workload and warning event in the cluster per call. Ten seconds is below
// anything a person would call stale; failures are never cached.
const OVERVIEW_CACHE_TTL_MS = 10_000;
const OVERVIEW_CACHE_MAX_ENTRIES = 4;
const overviewCache = createTtlCache<ClusterOverview>(OVERVIEW_CACHE_TTL_MS, { maxEntries: OVERVIEW_CACHE_MAX_ENTRIES });
onConfigChange(() => overviewCache.clear());

export function getClusterOverviewCached(namespace: string | null): Promise<ClusterOverview> {
  const key = `${getActiveContextName() ?? ''}|${namespace ?? ''}`;
  return overviewCache.get(key, () => getClusterOverview(namespace));
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_cluster_overview', async (args) => getClusterOverviewCached(optStr(args, 'namespace') ?? null));
}
