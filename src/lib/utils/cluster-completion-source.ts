/**
 * Live cluster values for YAML autocompletion.
 *
 * A schema can say `serviceAccountName` is a string; only the cluster can say
 * which ServiceAccounts exist in this namespace. This module supplies those
 * names for the handful of fields whose valid values are objects that already
 * exist.
 *
 * Everything here is best-effort. A lookup that fails — no cluster, RBAC denial,
 * a slow apiserver — resolves to an empty list, because a missing suggestion is
 * a much smaller problem than an editor that stalls or throws while typing.
 */

import { invoke } from "$lib/ipc/core";
import type { ResourceList } from "$lib/types";
import type { PathSegment } from "./yaml-ast";

/** How long a fetched name list stays fresh. Long enough that typing a whole
 *  block costs one request, short enough to notice a newly created object. */
const TTL_MS = 30_000;

interface CacheEntry {
  names: string[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

function cacheKey(resourceType: string, namespace: string): string {
  return `${resourceType}/${namespace}`;
}

/**
 * Names of one resource type in one namespace, from cache when fresh.
 * Never rejects.
 */
export async function namesOf(resourceType: string, namespace: string): Promise<string[]> {
  const k = cacheKey(resourceType, namespace);

  const hit = cache.get(k);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.names;

  const pending = inFlight.get(k);
  if (pending) return pending;

  const request = invoke<ResourceList>("list_resources", { resourceType, namespace })
    .then((list) => {
      const names = (list?.items ?? [])
        .map((item) => item.metadata?.name)
        .filter((name): name is string => typeof name === "string" && name !== "")
        .sort();
      cache.set(k, { names, fetchedAt: Date.now() });
      return names;
    })
    .catch(() => [] as string[])
    .finally(() => {
      inFlight.delete(k);
    });

  inFlight.set(k, request);
  return request;
}

/** Namespace names in the cluster. Never rejects. */
export async function namespaceNames(): Promise<string[]> {
  const k = cacheKey("namespaces", "");
  const hit = cache.get(k);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.names;

  const pending = inFlight.get(k);
  if (pending) return pending;

  const request = invoke<string[]>("get_namespaces")
    .then((names) => {
      const value = (names ?? []).filter((n) => typeof n === "string").sort();
      cache.set(k, { names: value, fetchedAt: Date.now() });
      return value;
    })
    .catch(() => [] as string[])
    .finally(() => {
      inFlight.delete(k);
    });

  inFlight.set(k, request);
  return request;
}

/** Drop every cached list. Called on context switch (see k8s.svelte.ts). */
export function clearClusterCompletionCache(): void {
  cache.clear();
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Which field takes which resource
// ---------------------------------------------------------------------------

/** A field whose values are names of existing objects. */
export interface ClusterValueSource {
  /** resource_type accepted by list_resources; "namespaces" is special-cased. */
  resourceType: string;
  /** Shown beside each suggestion. */
  detail: string;
  /** True for cluster-scoped kinds, which ignore the namespace argument. */
  clusterScoped?: boolean;
}

/**
 * Fields whose value names another object, keyed by `<parent>.<key>`.
 *
 * Matching on the last two segments rather than a full path is deliberate: the
 * same reference appears at many depths — `secretKeyRef.name` occurs under
 * containers, initContainers and ephemeralContainers alike — and a bare `name`
 * must never be treated as a reference.
 */
const BY_PARENT_AND_KEY: Record<string, ClusterValueSource> = {
  "configMapKeyRef.name": { resourceType: "configmaps", detail: "ConfigMap" },
  "configMapRef.name": { resourceType: "configmaps", detail: "ConfigMap" },
  "secretKeyRef.name": { resourceType: "secrets", detail: "Secret" },
  "secretRef.name": { resourceType: "secrets", detail: "Secret" },
  "configMap.name": { resourceType: "configmaps", detail: "ConfigMap" },
  "secret.secretName": { resourceType: "secrets", detail: "Secret" },
  "persistentVolumeClaim.claimName": {
    resourceType: "persistentvolumeclaims",
    detail: "PersistentVolumeClaim",
  },
};

/** Fields identified by their key alone, at any depth. */
const BY_KEY: Record<string, ClusterValueSource> = {
  namespace: { resourceType: "namespaces", detail: "Namespace", clusterScoped: true },
  serviceAccountName: { resourceType: "serviceaccounts", detail: "ServiceAccount" },
  serviceAccount: { resourceType: "serviceaccounts", detail: "ServiceAccount" },
  nodeName: { resourceType: "nodes", detail: "Node", clusterScoped: true },
  storageClassName: { resourceType: "storageclasses", detail: "StorageClass", clusterScoped: true },
  ingressClassName: {
    resourceType: "ingressclasses",
    detail: "IngressClass",
    clusterScoped: true,
  },
  priorityClassName: {
    resourceType: "priorityclasses",
    detail: "PriorityClass",
    clusterScoped: true,
  },
  runtimeClassName: { resourceType: "runtimeclasses", detail: "RuntimeClass", clusterScoped: true },
  claimName: { resourceType: "persistentvolumeclaims", detail: "PersistentVolumeClaim" },
};

/**
 * The cluster resource a path's value refers to, or null when the field is not
 * a reference to an existing object.
 */
export function clusterSourceFor(path: PathSegment[]): ClusterValueSource | null {
  if (path.length === 0) return null;

  const key = path[path.length - 1];
  if (typeof key !== "string") return null;

  // Nearest string ancestor, skipping array indices: for
  // ["spec","volumes",0,"configMap","name"] that is "configMap".
  let parent: string | null = null;
  for (let i = path.length - 2; i >= 0; i--) {
    const segment = path[i];
    if (typeof segment === "string") {
      parent = segment;
      break;
    }
  }

  if (parent) {
    const pairMatch = BY_PARENT_AND_KEY[`${parent}.${key}`];
    if (pairMatch) return pairMatch;
  }

  return BY_KEY[key] ?? null;
}

/** Resolve the values for a field, or an empty list when it is not a reference. */
export async function clusterValuesFor(
  path: PathSegment[],
  namespace: string,
): Promise<{ values: string[]; detail: string }> {
  const source = clusterSourceFor(path);
  if (!source) return { values: [], detail: "" };

  if (source.resourceType === "namespaces") {
    return { values: await namespaceNames(), detail: source.detail };
  }

  const scope = source.clusterScoped ? "" : namespace;
  return { values: await namesOf(source.resourceType, scope), detail: source.detail };
}

// Test exports
export { BY_KEY as _BY_KEY, BY_PARENT_AND_KEY as _BY_PARENT_AND_KEY, TTL_MS as _TTL_MS };
