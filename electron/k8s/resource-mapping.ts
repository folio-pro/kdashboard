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
