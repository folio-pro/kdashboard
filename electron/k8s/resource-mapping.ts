// Canonical k8s-object -> Resource projection.
//
// Shared by the resources, watch and CRD paths. Previously copied (with subtly
// divergent null/undefined handling) into three handler files.
//
// NULL CONTRACT: metadata fields serialize as `null` when absent, while
// spec/status/data/type are OMITTED when absent. The renderer was built against
// exactly this split — see resource-mapping.test.ts.

import type { RawObject, RawObjectMeta, Resource, ResourceMetadata } from './resource-types';
import { apiVersionOf, RESOURCE_TYPES, type ListFields } from './kinds';

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
    deletion_timestamp: meta.deletionTimestamp ?? null,
    // Only included when non-empty.
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

/** Drop a value if it is null/undefined. */
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

type FieldSel = ListFields;

/**
 * Per resource_type: api_version + kind + which fields project, derived from the
 * shared registry (kind is the SINGULAR Kind, e.g. "Pod"). Types with a
 * hand-written projection (pods, secrets) are resolved by SPECIAL_PROJECTIONS
 * first and never reach this table.
 */
export const GENERIC_KIND_TABLE: Record<
  string,
  { apiVersion: string; kind: string; fields: FieldSel }
> = Object.fromEntries(
  Object.values(RESOURCE_TYPES).map((e) => [
    e.type,
    { apiVersion: apiVersionOf(e.group, e.version), kind: e.kind, fields: e.list },
  ]),
);

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
  // Top-level fields that live outside spec/status (RoleBinding.roleRef,
  // ServiceAccount.secrets, …) are lifted into a synthetic spec so the table
  // and detail panel read them the same way as any other kind.
  if (fields.synth && fields.synth.length > 0) {
    const spec: Record<string, unknown> = { ...((res.spec as Record<string, unknown>) ?? {}) };
    for (const field of fields.synth) {
      const v = presentOrUndefined(obj[field]);
      if (v !== undefined) spec[field] = v;
    }
    res.spec = spec;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Pod projection
//
// The pods table only reads a handful of fields; project them so we never ship
// the full spec/status. The keys MUST match what TableRow.getCellValue +
// container status rendering read (and src/lib/types PodStatus/ContainerStatus):
//   spec.nodeName, spec.containers[].{name,image}, spec.initContainers[].{name,image}
//   status.{phase,podIP,hostIP,startTime}
//   status.conditions[].{type,status,reason}
//   status.containerStatuses[].{name,ready,restartCount,image,state,lastState,started}
//   status.initContainerStatuses[...]
// ---------------------------------------------------------------------------

interface RawContainer {
  name?: string;
  image?: string;
  /** requests/limits — kept so the table can show usage as a % of request. */
  resources?: unknown;
}
interface RawCondition {
  type?: string;
  status?: string;
  /** Why a condition is False — "Unschedulable" is what a Pending row shows. */
  reason?: string;
}
interface RawContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  image?: string;
  state?: unknown;
  /** The previous termination: its finishedAt is when the last restart happened. */
  lastState?: unknown;
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

/** Drop undefined-valued keys, so absent fields are omitted rather than null. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function projectContainer(c: RawContainer): Partial<RawContainer> {
  return compact({ name: c.name, image: c.image, resources: presentOrUndefined(c.resources) });
}

function projectContainerStatus(cs: RawContainerStatus): Partial<RawContainerStatus> {
  return compact({
    name: cs.name,
    ready: cs.ready,
    restartCount: cs.restartCount,
    image: cs.image,
    state: cs.state,
    lastState: presentOrUndefined(cs.lastState),
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
      conditions: rawStatus.conditions?.map((c) => compact({ type: c.type, status: c.status, reason: c.reason })),
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
    // pass them through verbatim.
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

// Types whose list shape is not the generic projection. RoleBinding /
// ClusterRoleBinding (roleRef + subjects) and VPA used to live here; they are
// now plain registry rows — the bindings via `synth`, VPA via spec+status.
const SPECIAL_PROJECTIONS: Record<string, (obj: RawObject) => Resource> = {
  pods: projectPod,
  secrets: projectSecret,
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
