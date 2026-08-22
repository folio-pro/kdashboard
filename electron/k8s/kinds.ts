// Canonical resource registry: one table for every built-in kind the app can
// list, watch, project and address by name.
//
// Two key spaces resolve against the same rows:
//   * RESOURCE_TYPES — keyed by the PLURAL/short `resource_type` the frontend
//     sends (pods, deployments, hpa, vpa, …). Used by list_resources,
//     get_resource_counts, the watch, and the list projections.
//   * KINDS          — keyed by SINGULAR kind aliases (pod, deployment, pvc, …)
//     for get_resource / get_resource_yaml / workload ops. Derived from
//     RESOURCE_TYPES: the lowercased Kind plus each entry's `aliases`.
//
// Adding a built-in kind means adding ONE row here; resources.ts, watch.ts,
// resource-mapping.ts and the diagnostics kind map all read from it.

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

/** Which top-level fields a LIST projection keeps for a resource type. */
export interface ListFields {
  spec: boolean;
  status: boolean;
  data: boolean;
  /**
   * Top-level fields that are neither spec nor status but that the table needs
   * (RoleBinding.roleRef, ServiceAccount.secrets, EndpointSlice.endpoints, …).
   * They are copied into a synthetic `spec` object on the projected Resource.
   */
  synth?: string[];
}

export interface ResourceTypeEntry extends KindEntry {
  /** The `resource_type` key the frontend sends. */
  type: string;
  list: ListFields;
  /** Extra singular aliases to register in KINDS (short names, mostly). */
  aliases?: string[];
}

/** apiVersion string for a group/version pair ('' group -> bare version). */
export function apiVersionOf(group: string, version: string): string {
  return group === '' ? version : `${group}/${version}`;
}

const NONE: ListFields = { spec: false, status: false, data: false };
const SPEC: ListFields = { spec: true, status: false, data: false };
const SPEC_STATUS: ListFields = { spec: true, status: true, data: false };
const DATA: ListFields = { spec: false, status: false, data: true };
const synth = (...fields: string[]): ListFields => ({ ...NONE, synth: fields });

const r = (
  type: string,
  group: string,
  version: string,
  plural: string,
  kind: string,
  clusterScoped: boolean,
  list: ListFields,
  aliases?: string[],
): ResourceTypeEntry => ({ type, group, version, plural, kind, clusterScoped, list, aliases });

/** resource_type -> full API coordinates + list projection. */
export const RESOURCE_TYPES: Record<string, ResourceTypeEntry> = {
  // --- Workloads ---------------------------------------------------------
  // Pods have a hand-written projection (see resource-mapping.ts); the flags
  // here only describe what the generic path WOULD keep.
  pods: r('pods', '', 'v1', 'pods', 'Pod', false, SPEC_STATUS),
  deployments: r('deployments', 'apps', 'v1', 'deployments', 'Deployment', false, SPEC_STATUS, ['deploy']),
  replicasets: r('replicasets', 'apps', 'v1', 'replicasets', 'ReplicaSet', false, SPEC_STATUS, ['rs']),
  statefulsets: r('statefulsets', 'apps', 'v1', 'statefulsets', 'StatefulSet', false, SPEC_STATUS, ['sts']),
  daemonsets: r('daemonsets', 'apps', 'v1', 'daemonsets', 'DaemonSet', false, SPEC_STATUS, ['ds']),
  jobs: r('jobs', 'batch', 'v1', 'jobs', 'Job', false, SPEC_STATUS),
  cronjobs: r('cronjobs', 'batch', 'v1', 'cronjobs', 'CronJob', false, SPEC_STATUS, ['cj']),

  // --- Network -----------------------------------------------------------
  services: r('services', '', 'v1', 'services', 'Service', false, SPEC_STATUS, ['svc']),
  ingresses: r('ingresses', 'networking.k8s.io', 'v1', 'ingresses', 'Ingress', false, SPEC_STATUS, ['ing']),
  ingressclasses: r('ingressclasses', 'networking.k8s.io', 'v1', 'ingressclasses', 'IngressClass', true, SPEC),
  endpoints: r('endpoints', '', 'v1', 'endpoints', 'Endpoints', false, synth('subsets'), ['ep']),
  endpointslices: r('endpointslices', 'discovery.k8s.io', 'v1', 'endpointslices', 'EndpointSlice', false, synth('addressType', 'endpoints', 'ports')),

  // --- Configuration -----------------------------------------------------
  configmaps: r('configmaps', '', 'v1', 'configmaps', 'ConfigMap', false, DATA, ['cm']),
  // Secrets have a hand-written projection (base64 data + the `type` field).
  secrets: r('secrets', '', 'v1', 'secrets', 'Secret', false, DATA),

  // --- Scaling -----------------------------------------------------------
  hpa: r('hpa', 'autoscaling', 'v2', 'horizontalpodautoscalers', 'HorizontalPodAutoscaler', false, SPEC_STATUS, ['hpa']),
  vpa: r('vpa', 'autoscaling.k8s.io', 'v1', 'verticalpodautoscalers', 'VerticalPodAutoscaler', false, SPEC_STATUS, ['vpa']),
  wpa: r('wpa', 'datadoghq.com', 'v1alpha1', 'watermarkpodautoscalers', 'WatermarkPodAutoscaler', false, SPEC_STATUS, ['wpa']),

  // --- Storage -----------------------------------------------------------
  persistentvolumes: r('persistentvolumes', '', 'v1', 'persistentvolumes', 'PersistentVolume', true, SPEC_STATUS, ['pv']),
  persistentvolumeclaims: r('persistentvolumeclaims', '', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim', false, SPEC_STATUS, ['pvc']),
  storageclasses: r('storageclasses', 'storage.k8s.io', 'v1', 'storageclasses', 'StorageClass', true, synth('provisioner', 'reclaimPolicy', 'volumeBindingMode', 'allowVolumeExpansion'), ['sc']),
  csidrivers: r('csidrivers', 'storage.k8s.io', 'v1', 'csidrivers', 'CSIDriver', true, SPEC),
  volumeattachments: r('volumeattachments', 'storage.k8s.io', 'v1', 'volumeattachments', 'VolumeAttachment', true, SPEC_STATUS),

  // --- RBAC --------------------------------------------------------------
  serviceaccounts: r('serviceaccounts', '', 'v1', 'serviceaccounts', 'ServiceAccount', false, synth('secrets', 'imagePullSecrets', 'automountServiceAccountToken'), ['sa']),
  roles: r('roles', 'rbac.authorization.k8s.io', 'v1', 'roles', 'Role', false, NONE),
  rolebindings: r('rolebindings', 'rbac.authorization.k8s.io', 'v1', 'rolebindings', 'RoleBinding', false, synth('roleRef', 'subjects'), ['rb']),
  clusterroles: r('clusterroles', 'rbac.authorization.k8s.io', 'v1', 'clusterroles', 'ClusterRole', true, NONE),
  clusterrolebindings: r('clusterrolebindings', 'rbac.authorization.k8s.io', 'v1', 'clusterrolebindings', 'ClusterRoleBinding', true, synth('roleRef', 'subjects'), ['crb']),

  // --- Policy ------------------------------------------------------------
  networkpolicies: r('networkpolicies', 'networking.k8s.io', 'v1', 'networkpolicies', 'NetworkPolicy', false, SPEC, ['netpol']),
  resourcequotas: r('resourcequotas', '', 'v1', 'resourcequotas', 'ResourceQuota', false, SPEC_STATUS, ['quota']),
  limitranges: r('limitranges', '', 'v1', 'limitranges', 'LimitRange', false, SPEC, ['limits']),
  poddisruptionbudgets: r('poddisruptionbudgets', 'policy', 'v1', 'poddisruptionbudgets', 'PodDisruptionBudget', false, SPEC_STATUS, ['pdb']),
  mutatingwebhookconfigurations: r('mutatingwebhookconfigurations', 'admissionregistration.k8s.io', 'v1', 'mutatingwebhookconfigurations', 'MutatingWebhookConfiguration', true, synth('webhooks')),
  validatingwebhookconfigurations: r('validatingwebhookconfigurations', 'admissionregistration.k8s.io', 'v1', 'validatingwebhookconfigurations', 'ValidatingWebhookConfiguration', true, synth('webhooks')),

  // --- Cluster -----------------------------------------------------------
  nodes: r('nodes', '', 'v1', 'nodes', 'Node', true, SPEC_STATUS, ['no']),
  namespaces: r('namespaces', '', 'v1', 'namespaces', 'Namespace', true, SPEC_STATUS, ['ns']),
  priorityclasses: r('priorityclasses', 'scheduling.k8s.io', 'v1', 'priorityclasses', 'PriorityClass', true, synth('value', 'globalDefault', 'preemptionPolicy', 'description'), ['pc']),
  runtimeclasses: r('runtimeclasses', 'node.k8s.io', 'v1', 'runtimeclasses', 'RuntimeClass', true, synth('handler')),
  leases: r('leases', 'coordination.k8s.io', 'v1', 'leases', 'Lease', false, SPEC),
  // core/v1 Event keeps everything at the top level (no spec/status), so the
  // table fields ride in via `synth`. The per-resource get_events handler keeps
  // serving the detail panel; this row is what backs the global Events view.
  events: r('events', '', 'v1', 'events', 'Event', false, synth('type', 'reason', 'message', 'count', 'source', 'involvedObject', 'firstTimestamp', 'lastTimestamp', 'eventTime', 'series', 'reportingComponent'), ['ev']),
};

/** Resolve a `resource_type` (exact key, as sent by the frontend). */
export function resolveResourceType(type: string): ResourceTypeEntry | undefined {
  return RESOURCE_TYPES[type];
}

const toKindEntry = (e: ResourceTypeEntry): KindEntry => ({
  group: e.group,
  version: e.version,
  plural: e.plural,
  kind: e.kind,
  clusterScoped: e.clusterScoped,
});

function buildKinds(): Record<string, KindEntry> {
  const out: Record<string, KindEntry> = {};
  for (const entry of Object.values(RESOURCE_TYPES)) {
    const k = toKindEntry(entry);
    out[entry.kind.toLowerCase()] = k;
    for (const alias of entry.aliases ?? []) out[alias.toLowerCase()] = k;
  }
  return out;
}

/** kind alias (lowercase) -> entry. Includes the short-name aliases the UI uses. */
export const KINDS: Record<string, KindEntry> = buildKinds();

/** Resolve a kind alias (case-insensitive). Returns undefined for unknown kinds. */
export function resolveKind(kind: string): KindEntry | undefined {
  return KINDS[kind.toLowerCase()];
}

/**
 * Resolve a kind or throw the canonical unsupported-kind error, shared by both
 * the YAML fetch and workload ops paths.
 */
export function resolveKindOrThrow(kind: string): KindEntry {
  const entry = resolveKind(kind);
  if (!entry) {
    throw new Error(`Unsupported kind for YAML fetch: ${kind}`);
  }
  return entry;
}
