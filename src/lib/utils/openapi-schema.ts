/**
 * Renderer side of the cluster's OpenAPI v3 schemas.
 *
 * Fetches a kind's schema closure over IPC (see electron/handlers/openapi.ts),
 * caches it, and exposes it through the same shallow lookup interface the
 * hand-written schema uses — so autocompletion and linting never need to know
 * which source answered.
 *
 * Resolution is deliberately lazy: the closure stays as raw OpenAPI and is
 * walked one level at a time. Converting it eagerly into a nested tree would not
 * terminate, because Kubernetes schemas are genuinely cyclic (JSONSchemaProps
 * contains itself, and every CRD carries one).
 */

import { invoke } from "$lib/ipc/core";
import type { SchemaField } from "./k8s-schema-fields";
import type { PathSegment } from "./yaml-ast";

/** A JSON Schema node as served by the apiserver. Mirrors the Electron type. */
export interface OpenApiSchema {
  type?: string;
  description?: string;
  format?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  additionalProperties?: OpenApiSchema | boolean;
  allOf?: OpenApiSchema[];
  $ref?: string;
  "x-kubernetes-group-version-kind"?: Array<{ group: string; version: string; kind: string }>;
  default?: unknown;
}

export interface OpenApiSchemaResult {
  available: boolean;
  root: string | null;
  schemas: Record<string, OpenApiSchema>;
  reason: string | null;
}

const UNAVAILABLE: OpenApiSchemaResult = {
  available: false,
  root: null,
  schemas: {},
  reason: null,
};

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

const cache = new Map<string, OpenApiSchemaResult>();
/** In-flight requests, so opening three tabs of the same kind fetches once. */
const inFlight = new Map<string, Promise<OpenApiSchemaResult>>();

/**
 * Bumped by clearOpenApiCache. Captured before each request and re-checked
 * before the write, so a response already in flight when the user switched
 * context cannot repopulate the cache with the previous cluster's schema.
 */
let cacheGeneration = 0;

function cacheKey(apiVersion: string, kind: string): string {
  return `${apiVersion} ${kind}`;
}

/**
 * Load the schema closure for one kind. Never rejects: a cluster that cannot
 * serve OpenAPI (pre-1.23, or RBAC-restricted) yields `available: false` and the
 * caller falls back to the static schema.
 */
export async function fetchOpenApiSchema(
  apiVersion: string,
  kind: string,
): Promise<OpenApiSchemaResult> {
  if (!apiVersion || !kind) return UNAVAILABLE;

  const key = cacheKey(apiVersion, kind);
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const generation = cacheGeneration;
  const request = invoke<OpenApiSchemaResult>("get_openapi_schema", { apiVersion, kind })
    .catch((): OpenApiSchemaResult => UNAVAILABLE)
    .then((result) => {
      const value = result ?? UNAVAILABLE;
      // A context switch while this was in flight means the schema describes
      // the previous cluster; answer this caller but leave the cache empty.
      if (generation === cacheGeneration) cache.set(key, value);
      inFlight.delete(key);
      return value;
    });

  inFlight.set(key, request);
  return request;
}

/** Cached result for a kind, or null when it has not been fetched yet. */
export function peekOpenApiSchema(apiVersion: string, kind: string): OpenApiSchemaResult | null {
  return cache.get(cacheKey(apiVersion, kind)) ?? null;
}

/** Drop every cached schema. Called on context switch (see schema-provider). */
export function clearOpenApiCache(): void {
  cache.clear();
  inFlight.clear();
  cacheGeneration++;
}

// ---------------------------------------------------------------------------
// Walking the closure
// ---------------------------------------------------------------------------

const REF_PREFIX = "#/components/schemas/";

/**
 * Follow `$ref` (and the single-ref `allOf` form the apiserver emits for
 * annotated references) until reaching a concrete node.
 *
 * The hop limit guards against a `$ref` cycle with no intervening object, which
 * a malformed CRD could produce.
 */
export function deref(
  schema: OpenApiSchema | undefined,
  schemas: Record<string, OpenApiSchema>,
  hops = 0,
): OpenApiSchema | undefined {
  if (!schema || hops > 16) return schema;

  if (schema.$ref?.startsWith(REF_PREFIX)) {
    return deref(schemas[schema.$ref.slice(REF_PREFIX.length)], schemas, hops + 1);
  }

  // `allOf: [{ $ref }]` with sibling keywords: the ref carries the shape, the
  // siblings carry the description. Merge so neither is lost.
  if (schema.allOf?.length === 1 && !schema.type && !schema.properties) {
    const base = deref(schema.allOf[0], schemas, hops + 1);
    if (base) return { ...base, description: schema.description ?? base.description };
  }

  return schema;
}

/** Translate an OpenAPI type onto the SchemaField vocabulary. */
function fieldType(schema: OpenApiSchema): SchemaField["type"] {
  switch (schema.type) {
    case "object":
      return "object";
    case "array":
      return "array";
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      // Untyped nodes are usually IntOrString or RawExtension, both of which
      // accept more than one shape.
      return schema.properties ? "object" : "any";
  }
}

/**
 * Convert one OpenAPI node to a SchemaField, shallowly.
 *
 * `children` and `items` are intentionally left unset — consumers navigate via
 * `fieldsAtPath` instead, which is what keeps cyclic schemas finite.
 */
function toField(
  schema: OpenApiSchema,
  schemas: Record<string, OpenApiSchema>,
  required: boolean,
): SchemaField {
  const resolved = deref(schema, schemas) ?? schema;
  const field: SchemaField = { type: fieldType(resolved) };
  if (resolved.description) field.desc = resolved.description;
  if (resolved.enum?.length) field.enum = resolved.enum;
  if (required) field.required = true;
  return field;
}

/**
 * Descend one path segment. Mapping keys read `properties`; a key not listed
 * there falls back to `additionalProperties`, which is how open maps such as
 * `metadata.labels` are typed. Numeric segments index into `items`.
 */
function step(
  node: OpenApiSchema | undefined,
  segment: PathSegment,
  schemas: Record<string, OpenApiSchema>,
): OpenApiSchema | undefined {
  const current = deref(node, schemas);
  if (!current) return undefined;

  if (typeof segment === "number") {
    return deref(current.items, schemas);
  }

  const direct = current.properties?.[segment];
  if (direct) return deref(direct, schemas);

  // A sequence path may omit its index (the cursor sits on a fresh `- `), so a
  // key lookup against an array falls through to the item schema.
  if (current.type === "array" && current.items) {
    return step(current.items, segment, schemas);
  }

  if (current.additionalProperties && typeof current.additionalProperties === "object") {
    return deref(current.additionalProperties, schemas);
  }

  return undefined;
}

/** Resolve the node at a path, or undefined when the path is not in the schema. */
export function nodeAtPath(
  result: OpenApiSchemaResult,
  path: PathSegment[],
): OpenApiSchema | undefined {
  if (!result.available || !result.root) return undefined;
  let node = deref(result.schemas[result.root], result.schemas);
  for (const segment of path) {
    node = step(node, segment, result.schemas);
    if (!node) return undefined;
  }
  return node;
}

/**
 * Child fields available at a path — the map autocompletion offers.
 * Returns null when the path is unknown or describes no declared properties,
 * which is what stops the caller from claiming a field is "unknown".
 */
export function fieldsAtPath(
  result: OpenApiSchemaResult,
  path: PathSegment[],
): Record<string, SchemaField> | null {
  let node = nodeAtPath(result, path);
  if (!node) return null;

  // A sequence key without an index still describes its entries.
  if (node.type === "array" && node.items) {
    node = deref(node.items, result.schemas) ?? node;
  }

  if (!node.properties) return null;

  const required = new Set(node.required ?? []);
  const out: Record<string, SchemaField> = {};
  for (const [name, child] of Object.entries(node.properties)) {
    out[name] = toField(child, result.schemas, required.has(name));
  }
  return out;
}

/** The field describing the value at a path, for hovers and value completion. */
export function fieldAtPath(result: OpenApiSchemaResult, path: PathSegment[]): SchemaField | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];

  const parent = nodeAtPath(result, parentPath);
  if (!parent) return null;

  const node = nodeAtPath(result, path);
  if (!node) return null;

  const required = typeof key === "string" && (parent.required ?? []).includes(key);
  return toField(node, result.schemas, required);
}
