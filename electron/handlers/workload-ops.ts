// Handler module: workload-ops
//
// Commands:
//   apply_yaml               -> apply (create-or-update) a resource from a YAML string (server-side apply)
//   delete_resource          -> delete a single resource by kind/name/namespace (+ uid/resourceVersion preconditions)
//   scale_workload           -> patch spec.replicas
//   restart_workload         -> patch pod-template restartedAt annotation
//   rollback_deployment      -> copy a target ReplicaSet's pod template onto the Deployment
//   list_deployment_revisions-> list owned ReplicaSets as revisions, newest first
//
// The Svelte UI (src/lib/components/details/revision-history-card.logic.ts)
// consumes RevisionInfo with snake_case fields — matched exactly below.

import {
  AppsV1Api,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
  type V1ReplicaSet,
} from '@kubernetes/client-node';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { kc } from '../k8s/client.js';
import { apiVersionOf, resolveKindOrThrow } from '../k8s/kinds.js';
import { k8sErrorMessage } from '../k8s/errors.js';
import type { HandlerCtx, HandlerMap } from '../dispatch.js';

// ---------------------------------------------------------------------------
// Result type interfaces (wire shapes the renderer depends on)
// ---------------------------------------------------------------------------

/**
 * Summary of a Deployment revision surfaced in the UI for rollback selection.
 * Field names are snake_case to match the TS interface in
 * src/lib/components/details/revision-history-card.logic.ts.
 */
export interface RevisionInfo {
  revision: number;
  name: string;
  created_at: string | null;
  images: string[];
  replicas: number;
  is_current: boolean;
}

// ---------------------------------------------------------------------------
// Kind -> ApiResource resolution (ported from helpers::api_resource_for_kind)
// ---------------------------------------------------------------------------

interface KindInfo {
  /** apiVersion string, e.g. "apps/v1" or "v1". */
  apiVersion: string;
  /** PascalCase Kind for the manifest, e.g. "Deployment". */
  kind: string;
}

/**
 * Resolve apiVersion + Kind for a kind string, via the canonical kind registry
 * (electron/k8s/kinds.ts). Throws on an unsupported kind.
 */
function apiResourceForKind(kind: string): KindInfo {
  const entry = resolveKindOrThrow(kind);
  return { apiVersion: apiVersionOf(entry.group, entry.version), kind: entry.kind };
}

// ---------------------------------------------------------------------------
// Arg coercion helpers
// ---------------------------------------------------------------------------

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new Error(`Missing or invalid '${key}' argument`);
  }
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new Error(`Invalid '${key}' argument`);
  }
  return v;
}

function objectApi(): KubernetesObjectApi {
  return KubernetesObjectApi.makeApiClient(kc());
}

function appsApi(): AppsV1Api {
  return kc().makeApiClient(AppsV1Api);
}

// ---------------------------------------------------------------------------
// ReplicaSet revision helpers
// ---------------------------------------------------------------------------

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';

/** Revision number from a ReplicaSet's annotations; 0 if missing/unparseable. */
function rsRevision(rs: V1ReplicaSet): number {
  const raw = rs.metadata?.annotations?.[REVISION_ANNOTATION];
  if (raw === undefined) return 0;
  // Reject anything that isn't a clean non-negative integer.
  if (!/^\d+$/.test(raw.trim())) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Container images from a ReplicaSet's pod template. */
function rsImages(rs: V1ReplicaSet): string[] {
  const containers = rs.spec?.template?.spec?.containers ?? [];
  const images: string[] = [];
  for (const c of containers) {
    if (typeof c.image === 'string') images.push(c.image);
  }
  return images;
}

/**
 * Fetch ReplicaSets owned by the given Deployment, sorted by revision descending
 * (newest first). The ReplicaSet list is server-side filtered by the
 * Deployment's spec.selector.matchLabels (Deployment-owned ReplicaSets always
 * carry the selector labels, plus pod-template-hash), so we never download the
 * whole namespace's ReplicaSets. The deployment read must complete first — the
 * selector comes from it — so the two calls cannot run in parallel.
 * Matching by the Deployment's UID (not name) is kept as a safeguard so
 * orphaned ReplicaSets from a previously deleted Deployment of the same name
 * (or unrelated ReplicaSets that happen to share the labels) are excluded.
 */
async function fetchSortedRevisions(name: string, namespace: string): Promise<V1ReplicaSet[]> {
  const api = appsApi();
  const deployment = await api.readNamespacedDeployment({ name, namespace });
  const deploymentUid = deployment.metadata?.uid;
  if (!deploymentUid) {
    throw new Error(`Deployment ${name} has no UID`);
  }

  const matchLabels = deployment.spec?.selector?.matchLabels ?? {};
  const labelSelector = Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');

  const rsList = await api.listNamespacedReplicaSet({
    namespace,
    ...(labelSelector.length > 0 ? { labelSelector } : {}),
  });
  const owned = rsList.items.filter((rs) =>
    (rs.metadata?.ownerReferences ?? []).some(
      (ref) => ref.controller === true && ref.uid === deploymentUid,
    ),
  );

  owned.sort((a, b) => rsRevision(b) - rsRevision(a));
  return owned;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

/**
 * apply_yaml: apply (create or update) a resource from raw YAML using
 * server-side apply with force. Returns the resulting object re-serialized to
 * YAML, matching apply_resource_yaml.
 */
async function applyYaml(args: Record<string, unknown>): Promise<string> {
  const yamlStr = reqStr(args, 'yaml');

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(yamlStr);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    data = parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Strip server-generated metadata fields that the API rejects in apply requests.
  const metadata = data.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>;
    for (const key of [
      'managedFields',
      'resourceVersion',
      'uid',
      'creationTimestamp',
      'generation',
      'selfLink',
    ]) {
      delete meta[key];
    }
  }

  if (typeof data.kind !== 'string') {
    throw new Error("YAML must contain a 'kind' field");
  }

  const metaObj =
    data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : undefined;
  const name = metaObj?.name;
  if (typeof name !== 'string') {
    throw new Error('YAML must contain metadata.name');
  }

  // namespace defaults to "default".
  if (metaObj && typeof metaObj.namespace !== 'string') {
    metaObj.namespace = 'default';
  }

  const spec = data as unknown as KubernetesObject;

  try {
    const result = await objectApi().patch(
      spec,
      undefined, // pretty
      undefined, // dryRun
      'kdashboard', // fieldManager
      true, // force
      PatchStrategy.ServerSideApply,
    );
    return stringifyYaml(result);
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }
}

/**
 * delete_resource: delete a single resource by kind/name/namespace, with
 * optional uid / resourceVersion preconditions.
 */
async function deleteResource(args: Record<string, unknown>): Promise<null> {
  const kind = reqStr(args, 'kind');
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');
  const uid = optStr(args, 'uid');
  // Frontend sends snake_case 'resource_version' (see ResourceTable.svelte / registry.ts).
  const resourceVersion = optStr(args, 'resource_version');

  const { apiVersion, kind: pascalKind } = apiResourceForKind(kind);

  const spec: KubernetesObject = {
    apiVersion,
    kind: pascalKind,
    metadata: {
      name,
      namespace,
    },
  };

  // Preconditions, when supplied, are passed via the V1DeleteOptions body.
  const body =
    uid !== undefined || resourceVersion !== undefined
      ? {
          preconditions: {
            ...(uid !== undefined ? { uid } : {}),
            ...(resourceVersion !== undefined ? { resourceVersion } : {}),
          },
        }
      : undefined;

  try {
    await objectApi().delete(
      spec,
      undefined, // pretty
      undefined, // dryRun
      undefined, // gracePeriodSeconds
      undefined, // orphanDependents
      undefined, // propagationPolicy
      body,
    );
    return null;
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }
}

/**
 * scale_workload: patch spec.replicas via a merge patch.
 */
async function scaleWorkload(args: Record<string, unknown>): Promise<null> {
  const kind = reqStr(args, 'kind');
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');
  const replicasRaw = args.replicas;
  if (typeof replicasRaw !== 'number' || !Number.isInteger(replicasRaw) || replicasRaw < 0) {
    throw new Error("Missing or invalid 'replicas' argument");
  }

  const { apiVersion, kind: pascalKind } = apiResourceForKind(kind);

  const patchSpec = {
    apiVersion,
    kind: pascalKind,
    metadata: { name, namespace },
    spec: { replicas: replicasRaw },
  } as unknown as KubernetesObject;

  try {
    await objectApi().patch(
      patchSpec,
      undefined, // pretty
      undefined, // dryRun
      undefined, // fieldManager
      undefined, // force
      PatchStrategy.MergePatch,
    );
    return null;
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }
}

/**
 * restart_workload: patch the pod template's restartedAt annotation with the
 * current RFC3339 timestamp (mirrors kubectl rollout restart).
 */
async function restartWorkload(args: Record<string, unknown>): Promise<null> {
  const kind = reqStr(args, 'kind');
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');

  const { apiVersion, kind: pascalKind } = apiResourceForKind(kind);
  const now = new Date().toISOString();

  const patchSpec = {
    apiVersion,
    kind: pascalKind,
    metadata: { name, namespace },
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': now,
          },
        },
      },
    },
  } as unknown as KubernetesObject;

  try {
    await objectApi().patch(
      patchSpec,
      undefined, // pretty
      undefined, // dryRun
      undefined, // fieldManager
      undefined, // force
      PatchStrategy.MergePatch,
    );
    return null;
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }
}

/**
 * list_deployment_revisions: list ReplicaSets owned by the Deployment as
 * revisions, newest first. The newest revision with running pods is current;
 * if none are running, the newest is flagged current.
 */
async function listDeploymentRevisions(args: Record<string, unknown>): Promise<RevisionInfo[]> {
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');

  let sorted: V1ReplicaSet[];
  try {
    sorted = await fetchSortedRevisions(name, namespace);
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  let currentIdx = sorted.findIndex((rs) => (rs.status?.replicas ?? 0) > 0);
  if (currentIdx === -1) currentIdx = 0;

  return sorted.map((rs, idx) => {
    const created = rs.metadata?.creationTimestamp;
    return {
      revision: rsRevision(rs),
      name: rs.metadata?.name ?? '',
      created_at: created ? new Date(created).toISOString() : null,
      images: rsImages(rs),
      replicas: rs.status?.replicas ?? 0,
      is_current: idx === currentIdx,
    };
  });
}

/**
 * rollback_deployment: copy the pod template from a target ReplicaSet onto the
 * Deployment via a merge patch. Returns a human "Rolled back to revision N".
 */
async function rollbackDeployment(args: Record<string, unknown>): Promise<string> {
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');
  const revisionRaw = args.revision;
  let revision: number | undefined;
  if (revisionRaw === undefined || revisionRaw === null) {
    revision = undefined;
  } else if (typeof revisionRaw === 'number' && Number.isInteger(revisionRaw)) {
    revision = revisionRaw;
  } else {
    throw new Error("Invalid 'revision' argument");
  }

  let sortedRs: V1ReplicaSet[];
  try {
    sortedRs = await fetchSortedRevisions(name, namespace);
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  if (sortedRs.length === 0) {
    throw new Error(`No ReplicaSets found for deployment ${name}`);
  }

  let targetRs: V1ReplicaSet;
  if (revision !== undefined) {
    const found = sortedRs.find((rs) => rsRevision(rs) === revision);
    if (!found) {
      throw new Error(`Revision ${revision} not found`);
    }
    targetRs = found;
  } else {
    const prev = sortedRs[1];
    if (!prev) {
      throw new Error('No previous revision found');
    }
    targetRs = prev;
  }

  const targetRev = rsRevision(targetRs);

  const targetTemplate = targetRs.spec?.template;
  if (targetTemplate === undefined) {
    throw new Error('Could not extract template from target ReplicaSet');
  }

  const patchSpec = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace },
    spec: { template: targetTemplate },
  } as unknown as KubernetesObject;

  try {
    await objectApi().patch(
      patchSpec,
      undefined, // pretty
      undefined, // dryRun
      undefined, // fieldManager
      undefined, // force
      PatchStrategy.MergePatch,
    );
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  return `Rolled back to revision ${targetRev}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('apply_yaml', async (args) => applyYaml(args));
  handlers.set('delete_resource', async (args) => deleteResource(args));
  handlers.set('scale_workload', async (args) => scaleWorkload(args));
  handlers.set('restart_workload', async (args) => restartWorkload(args));
  handlers.set('rollback_deployment', async (args) => rollbackDeployment(args));
  handlers.set('list_deployment_revisions', async (args) => listDeploymentRevisions(args));
}
