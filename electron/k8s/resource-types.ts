// Shared wire + raw-body types for the k8s handlers.
//
// `Resource` / `ResourceMetadata` mirror the Rust serde output exactly
// (src-tauri/src/k8s/resources/types.rs). None of the metadata fields carry
// #[serde(skip_serializing_if)], so they serialize as `null` when absent;
// spec/status/data/type DO skip when absent. The fields are typed `?: T | null`
// so both the (faithful) null form and an omitted form satisfy the contract.
//
// `RawObjectMeta` / `RawObject` are the camelCase JSON bodies returned by the
// @kubernetes/client-node REST/CustomObjects endpoints.

export interface ResourceMetadata {
  name?: string | null;
  namespace?: string | null;
  uid?: string | null;
  resource_version?: string | null;
  labels?: Record<string, string> | null;
  annotations?: Record<string, string> | null;
  creation_timestamp?: string | null;
  owner_references?: unknown;
}

export interface Resource {
  api_version: string;
  kind: string;
  metadata: ResourceMetadata;
  spec?: unknown;
  status?: unknown;
  data?: unknown;
  /** Only populated for Secrets (the Secret `type` field). Renamed from type_. */
  type?: string;
}

export interface ResourceList {
  items: Resource[];
}

export interface RawObjectMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  ownerReferences?: unknown[];
  managedFields?: unknown;
  [k: string]: unknown;
}

export interface RawObject {
  apiVersion?: string;
  kind?: string;
  metadata?: RawObjectMeta;
  spec?: unknown;
  status?: unknown;
  data?: unknown;
  stringData?: Record<string, string>;
  type?: string;
  roleRef?: unknown;
  subjects?: unknown;
  [k: string]: unknown;
}

export interface RawList {
  items?: RawObject[];
  metadata?: { continue?: string };
}
