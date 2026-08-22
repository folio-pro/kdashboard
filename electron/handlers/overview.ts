// Cluster overview handler — one command that feeds the Overview and Problems
// views: nodes with requests/usage, pod phase counts, every current problem
// (nodes, workloads, pods), the last hour of Warning events and the top pods
// by usage.
//
// Commands:
//   - get_cluster_overview  { namespace?: string | null }
//
// Lists are cluster-wide when allowed; a kind whose cluster-wide list is
// refused (403 under namespace-scoped RBAC) is re-listed in `namespace`, and
// anything that still fails is reported in `partial` rather than failing the
// whole command. The judging lives in electron/k8s/overview.ts.

import {
  Metrics,
  type CoreV1Event,
  type V1DaemonSet,
  type V1Deployment,
  type V1Job,
  type V1Node,
  type V1Pod,
  type V1StatefulSet,
} from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getAppsV1Api, getBatchV1Api, getCoreV1Api, kc } from '../k8s/client';
import {
  foldPodsIntoOwners,
  nodeProblems,
  orderProblems,
  podPhaseCounts,
  podProblems,
  recentWarnings,
  summarizeNodes,
  workloadProblems,
  type ClusterOverview,
  type NodeUsage,
  type TopPod,
} from '../k8s/overview';
import { parseCpu, parseMemory } from '../k8s/quantity';

const WARNING_WINDOW_MS = 60 * 60_000;
const TOP_PODS = 8;

interface Listed<T> {
  items: T[];
  /** 'cluster' | 'namespace' | null when the list failed entirely. */
  scope: 'cluster' | 'namespace' | null;
}

/**
 * Try the cluster-wide list; on failure (RBAC, usually) retry in `namespace`
 * when one is given. Never throws — a failed kind is reported as `scope: null`.
 */
async function listBoth<T>(
  clusterWide: () => Promise<{ items: T[] }>,
  namespaced: ((ns: string) => Promise<{ items: T[] }>) | null,
  namespace: string | null,
): Promise<Listed<T>> {
  try {
    const { items } = await clusterWide();
    return { items, scope: 'cluster' };
  } catch {
    if (!namespace || !namespaced) return { items: [], scope: null };
    try {
      const { items } = await namespaced(namespace);
      return { items, scope: 'namespace' };
    } catch {
      return { items: [], scope: null };
    }
  }
}

async function nodeUsage(): Promise<Map<string, NodeUsage> | null> {
  try {
    const list = await new Metrics(kc()).getNodeMetrics();
    const map = new Map<string, NodeUsage>();
    for (const m of list.items) {
      map.set(m.metadata.name, { cpu: parseCpu(m.usage.cpu), memory: parseMemory(m.usage.memory) });
    }
    return map;
  } catch {
    return null;
  }
}

async function topPods(namespace: string | null): Promise<{ cpu: TopPod[]; memory: TopPod[] } | null> {
  try {
    const metrics = new Metrics(kc());
    let list;
    try {
      list = await metrics.getPodMetrics();
    } catch (err) {
      if (!namespace) throw err;
      list = await metrics.getPodMetrics(namespace);
    }
    const rows: TopPod[] = list.items.map((pm) => ({
      name: pm.metadata.name,
      namespace: pm.metadata.namespace,
      cpu_usage: pm.containers.reduce((s, c) => s + parseCpu(c.usage.cpu), 0),
      memory_usage: pm.containers.reduce((s, c) => s + parseMemory(c.usage.memory), 0),
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

  const [nodes, pods, deployments, statefulsets, daemonsets, jobs, events, usage, top] = await Promise.all([
    listBoth<V1Node>(() => core.listNode(), null, null),
    listBoth<V1Pod>(() => core.listPodForAllNamespaces(), (ns) => core.listNamespacedPod({ namespace: ns }), namespace),
    listBoth<V1Deployment>(() => apps.listDeploymentForAllNamespaces(), (ns) => apps.listNamespacedDeployment({ namespace: ns }), namespace),
    listBoth<V1StatefulSet>(() => apps.listStatefulSetForAllNamespaces(), (ns) => apps.listNamespacedStatefulSet({ namespace: ns }), namespace),
    listBoth<V1DaemonSet>(() => apps.listDaemonSetForAllNamespaces(), (ns) => apps.listNamespacedDaemonSet({ namespace: ns }), namespace),
    listBoth<V1Job>(() => batch.listJobForAllNamespaces(), (ns) => batch.listNamespacedJob({ namespace: ns }), namespace),
    listBoth<CoreV1Event>(
      () => core.listEventForAllNamespaces({ fieldSelector: 'type=Warning' }),
      (ns) => core.listNamespacedEvent({ namespace: ns, fieldSelector: 'type=Warning' }),
      namespace,
    ),
    nodeUsage(),
    topPods(namespace),
  ]);

  const partial: string[] = [];
  const scopes = { nodes, pods, deployments, statefulsets, daemonsets, jobs, events };
  for (const [kind, listed] of Object.entries(scopes)) if (listed.scope === null) partial.push(kind);
  // The overview is "cluster" scoped when every namespaced kind listed cluster-wide.
  const namespacedScopes = [pods, deployments, statefulsets, daemonsets, jobs, events].map((l) => l.scope).filter((s) => s !== null);
  const scope: ClusterOverview['scope'] = namespacedScopes.length > 0 && namespacedScopes.every((s) => s === 'cluster') ? 'cluster' : 'namespace';

  const nodeRows = summarizeNodes(nodes.items, pods.scope === null ? null : pods.items, usage);
  const problems = orderProblems(
    foldPodsIntoOwners([
      ...nodeProblems(nodeRows),
      ...workloadProblems({ deployments: deployments.items, statefulsets: statefulsets.items, daemonsets: daemonsets.items, jobs: jobs.items }),
      ...podProblems(pods.items),
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

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_cluster_overview', async (args) => {
    const ns = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : null;
    return getClusterOverview(ns);
  });
}
