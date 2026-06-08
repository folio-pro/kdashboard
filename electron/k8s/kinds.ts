// Canonical kind -> GroupVersionResource registry.
//
// Single source of truth for the kind aliases the frontend sends and their
// API coordinates. Mirrors src-tauri/src/k8s/resources/helpers.rs
// api_resource_for_kind. Previously this table was duplicated (in three
// slightly different shapes) across resources.ts and workload-ops.ts.

export interface KindEntry {
  /** API group; '' for the core group. */
  group: string;
  version: string;
  /** Lowercase plural used in REST paths. */
  plural: string;
  /** PascalCase Kind used by KubernetesObjectApi / apiVersion+Kind callers. */
  kind: string;
  clusterScoped: boolean;
}

/** apiVersion string for a group/version pair ('' group -> bare version). */
export function apiVersionOf(group: string, version: string): string {
  return group === '' ? version : `${group}/${version}`;
}

const e = (
  group: string,
  version: string,
  plural: string,
  kind: string,
  clusterScoped: boolean,
): KindEntry => ({ group, version, plural, kind, clusterScoped });

/** kind alias (lowercase) -> entry. Includes the short-name aliases the UI uses. */
export const KINDS: Record<string, KindEntry> = {
  pod: e('', 'v1', 'pods', 'Pod', false),
  deployment: e('apps', 'v1', 'deployments', 'Deployment', false),
  service: e('', 'v1', 'services', 'Service', false),
  configmap: e('', 'v1', 'configmaps', 'ConfigMap', false),
  secret: e('', 'v1', 'secrets', 'Secret', false),
  ingress: e('networking.k8s.io', 'v1', 'ingresses', 'Ingress', false),
  statefulset: e('apps', 'v1', 'statefulsets', 'StatefulSet', false),
  daemonset: e('apps', 'v1', 'daemonsets', 'DaemonSet', false),
  job: e('batch', 'v1', 'jobs', 'Job', false),
  cronjob: e('batch', 'v1', 'cronjobs', 'CronJob', false),
  replicaset: e('apps', 'v1', 'replicasets', 'ReplicaSet', false),
  node: e('', 'v1', 'nodes', 'Node', true),
  namespace: e('', 'v1', 'namespaces', 'Namespace', true),
  horizontalpodautoscaler: e('autoscaling', 'v2', 'horizontalpodautoscalers', 'HorizontalPodAutoscaler', false),
  hpa: e('autoscaling', 'v2', 'horizontalpodautoscalers', 'HorizontalPodAutoscaler', false),
  verticalpodautoscaler: e('autoscaling.k8s.io', 'v1', 'verticalpodautoscalers', 'VerticalPodAutoscaler', false),
  vpa: e('autoscaling.k8s.io', 'v1', 'verticalpodautoscalers', 'VerticalPodAutoscaler', false),
  event: e('', 'v1', 'events', 'Event', false),
  networkpolicy: e('networking.k8s.io', 'v1', 'networkpolicies', 'NetworkPolicy', false),
  persistentvolume: e('', 'v1', 'persistentvolumes', 'PersistentVolume', true),
  pv: e('', 'v1', 'persistentvolumes', 'PersistentVolume', true),
  persistentvolumeclaim: e('', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim', false),
  pvc: e('', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim', false),
  storageclass: e('storage.k8s.io', 'v1', 'storageclasses', 'StorageClass', true),
  sc: e('storage.k8s.io', 'v1', 'storageclasses', 'StorageClass', true),
  role: e('rbac.authorization.k8s.io', 'v1', 'roles', 'Role', false),
  rolebinding: e('rbac.authorization.k8s.io', 'v1', 'rolebindings', 'RoleBinding', false),
  clusterrole: e('rbac.authorization.k8s.io', 'v1', 'clusterroles', 'ClusterRole', true),
  clusterrolebinding: e('rbac.authorization.k8s.io', 'v1', 'clusterrolebindings', 'ClusterRoleBinding', true),
  resourcequota: e('', 'v1', 'resourcequotas', 'ResourceQuota', false),
  limitrange: e('', 'v1', 'limitranges', 'LimitRange', false),
  poddisruptionbudget: e('policy', 'v1', 'poddisruptionbudgets', 'PodDisruptionBudget', false),
  pdb: e('policy', 'v1', 'poddisruptionbudgets', 'PodDisruptionBudget', false),
};

/** Resolve a kind alias (case-insensitive). Returns undefined for unknown kinds. */
export function resolveKind(kind: string): KindEntry | undefined {
  return KINDS[kind.toLowerCase()];
}

/**
 * Resolve a kind or throw the canonical unsupported-kind error (mirrors the
 * single Rust helper error string used by both YAML fetch and workload ops).
 */
export function resolveKindOrThrow(kind: string): KindEntry {
  const entry = resolveKind(kind);
  if (!entry) {
    throw new Error(`Unsupported kind for YAML fetch: ${kind}`);
  }
  return entry;
}
