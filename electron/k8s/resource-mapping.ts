// Canonical k8s-object -> Resource projection.
//
// Port of src-tauri/src/k8s/resources/helpers.rs meta_from + the dynamic-object
// projection reused by the resources, watch and CRD paths. Previously copied
// (with subtly divergent null/undefined handling) into three handler files.
//
// Faithful to Rust serde: metadata fields serialize as `null` when absent (the
// Rust struct has no skip_serializing_if on them); spec/status/data/type are
// omitted when absent.

import type { RawObject, RawObjectMeta, Resource, ResourceMetadata } from './resource-types';

/** Map k8s ObjectMeta -> ResourceMetadata (snake_case, null for absent fields). */
export function metaFrom(m: RawObjectMeta | undefined): ResourceMetadata {
  const meta = m ?? {};
  const owners = Array.isArray(meta.ownerReferences) ? meta.ownerReferences : undefined;
  return {
    name: meta.name ?? null,
    namespace: meta.namespace ?? null,
    uid: meta.uid ?? null,
    resource_version: meta.resourceVersion ?? null,
    labels: meta.labels ?? null,
    annotations: meta.annotations ?? null,
    creation_timestamp: meta.creationTimestamp ?? null,
    // Only included when non-empty (matches the Rust filter on !refs.is_empty()).
    owner_references: owners && owners.length > 0 ? owners : null,
  };
}

// kubectl stores the full applied manifest here — on list rows it duplicates
// the entire spec per item, so LIST projections prune it (detail/YAML keep it).
const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';

/**
 * metaFrom for LIST projections: identical to metaFrom, except the
 * `kubectl.kubernetes.io/last-applied-configuration` annotation is dropped
 * (it embeds the whole spec and bloats every row shipped over IPC). Detail
 * paths (get_resource / get_resource_yaml) must keep using metaFrom so the
 * full object stays intact.
 */
export function listMetaFrom(m: RawObjectMeta | undefined): ResourceMetadata {
  const meta = metaFrom(m);
  const ann = meta.annotations;
  if (ann && LAST_APPLIED_ANNOTATION in ann) {
    const { [LAST_APPLIED_ANNOTATION]: _dropped, ...rest } = ann;
    meta.annotations = rest;
  }
  return meta;
}

/** Drop a value if it is null/undefined (Rust's `.filter(|v| !v.is_null())`). */
export function presentOrUndefined<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

/**
 * Build a Resource from a dynamic object. api_version/kind come from the
 * resolved ApiResource (the body may omit them on some servers). spec/status/
 * data are taken verbatim when present; the Secret `type` field when a string.
 */
export function dynamicToResource(obj: RawObject, apiVersion: string, kind: string): Resource {
  const res: Resource = {
    api_version: apiVersion,
    kind,
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

// ---------------------------------------------------------------------------
// Per-resource_type LIST projections — the lean shapes list_resources ships to
// the renderer. The watch path MUST use the same projection: a watch event
// replaces a list row wholesale in the store, so a fatter projection would make
// rows grow to the full object (entire pod spec, last-applied annotation, …)
// as soon as the cluster churns — paying that size on every IPC event and
// keeping it resident in the renderer for the lifetime of the row.
// ---------------------------------------------------------------------------

interface FieldSel {
  spec: boolean;
  status: boolean;
  data: boolean;
}

// Per resource_type: api_version + kind + which fields project. Mirrors the
// listing.rs match arms (note kind is the SINGULAR Kind, e.g. "Pod").
// Entries handled specially (pods, secrets, bindings, vpa) are omitted here.
export const GENERIC_KIND_TABLE: Record<
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
  wpa: { apiVersion: 'datadoghq.com/v1alpha1', kind: 'WatermarkPodAutoscaler', fields: { spec: true, status: true, data: false } },
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

export function projectGeneric(
  obj: RawObject,
  apiVersion: string,
  kind: string,
  fields: FieldSel,
): Resource {
  const res: Resource = {
    api_version: apiVersion,
    kind,
    metadata: listMetaFrom(obj.metadata),
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

export function projectPod(obj: RawObject): Resource {
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
    metadata: listMetaFrom(obj.metadata),
  };
  if (spec !== undefined) res.spec = spec;
  if (status !== undefined) res.status = status;
  return res;
}

/** base64-encode every Secret data value; fall back to stringData. */
export function projectSecret(obj: RawObject): Resource {
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
    metadata: listMetaFrom(obj.metadata),
  };
  if (data !== undefined) res.data = data;
  if (obj.type !== undefined) res.type = obj.type;
  return res;
}

/** RoleBinding / ClusterRoleBinding -> synthetic spec { roleRef, subjects }. */
export function projectBinding(obj: RawObject, kind: string): Resource {
  const spec: Record<string, unknown> = {};
  if (obj.roleRef !== undefined) spec.roleRef = obj.roleRef;
  if (obj.subjects !== undefined) spec.subjects = obj.subjects;
  return {
    api_version: 'rbac.authorization.k8s.io/v1',
    kind,
    metadata: listMetaFrom(obj.metadata),
    spec,
  };
}

/** VPA (CRD) -> spec/status pulled straight from the object body. */
export function projectVpa(obj: RawObject): Resource {
  const res: Resource = {
    api_version: 'autoscaling.k8s.io/v1',
    kind: 'VerticalPodAutoscaler',
    metadata: listMetaFrom(obj.metadata),
  };
  const spec = presentOrUndefined(obj.spec);
  const status = presentOrUndefined(obj.status);
  if (spec !== undefined) res.spec = spec;
  if (status !== undefined) res.status = status;
  return res;
}

// Types whose list shape is not the generic FieldSel projection.
const SPECIAL_PROJECTIONS: Record<string, (obj: RawObject) => Resource> = {
  pods: projectPod,
  secrets: projectSecret,
  rolebindings: (obj) => projectBinding(obj, 'RoleBinding'),
  clusterrolebindings: (obj) => projectBinding(obj, 'ClusterRoleBinding'),
  vpa: projectVpa,
};

/**
 * The lean per-kind projector list_resources uses for `resourceType`, or null
 * when the type has no list projection (the caller decides how to fall back /
 * error). Resolve ONCE per listing/watch, then apply per object.
 */
export function listProjectionFor(resourceType: string): ((obj: RawObject) => Resource) | null {
  const special = SPECIAL_PROJECTIONS[resourceType];
  if (special) return special;
  const meta = GENERIC_KIND_TABLE[resourceType];
  if (meta) return (obj) => projectGeneric(obj, meta.apiVersion, meta.kind, meta.fields);
  return null;
}
