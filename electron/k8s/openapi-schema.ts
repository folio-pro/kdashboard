// OpenAPI v3 schema shapes and pure lookup helpers.
//
// Kept apart from handlers/openapi.ts because that module imports `electron` for
// the userData cache directory, which makes it unloadable outside an Electron
// process. Everything here is pure and unit-tested — the same split kinds.ts and
// quantity.ts already use.

/** A JSON Schema node as served by the apiserver, plus the K8s extensions. */
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
  'x-kubernetes-group-version-kind'?: Array<{ group: string; version: string; kind: string }>;
  'x-kubernetes-list-type'?: string;
  default?: unknown;
}

export interface OpenApiSchemaResult {
  /** False when the cluster cannot serve a schema; the renderer then falls back. */
  available: boolean;
  /** Key into `schemas` for the requested kind, e.g. io.k8s.api.apps.v1.Deployment. */
  root: string | null;
  /** The requested kind's schema plus every schema reachable from it. */
  schemas: Record<string, OpenApiSchema>;
  /** Why the schema is unavailable, for logging. Null on success. */
  reason: string | null;
}

export interface GroupDocument {
  components?: { schemas?: Record<string, OpenApiSchema> };
}

/**
 * Characters Kubernetes allows in an API group or version segment.
 *
 * This is a security boundary, not tidiness. The apiVersion is read out of the
 * YAML in the editor, so it is attacker-influenced whenever someone opens a
 * manifest they were sent, and the result of openApiPathFor is interpolated
 * both into the apiserver request path and into a cache filename that escapes
 * only `/`. Without this check `..\..\evil` passes as a single segment and
 * escapes the cache directory on Windows, and characters such as `?` and `#`
 * change which apiserver endpoint is requested.
 */
const GROUP_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

/**
 * Map a Kubernetes apiVersion onto its /openapi/v3 sub-path.
 * Core resources live under `api/v1`; everything else under `apis/<group>/<ver>`.
 */
export function openApiPathFor(apiVersion: string): string | null {
  const trimmed = apiVersion.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split('/');
  if (!parts.every((part) => GROUP_SEGMENT.test(part))) return null;
  if (parts.length === 1) return `api/${parts[0]}`;
  if (parts.length === 2) return `apis/${parts[0]}/${parts[1]}`;
  return null;
}

/**
 * Find the schema definition for a group/version/kind.
 *
 * The apiserver tags each top-level type with x-kubernetes-group-version-kind,
 * which is authoritative. The name-suffix check below is only a fallback for
 * aggregated apiservers that omit the extension.
 */
export function findRootSchema(
  schemas: Record<string, OpenApiSchema>,
  apiVersion: string,
  kind: string,
): string | null {
  const parts = apiVersion.split('/');
  const group = parts.length === 2 ? parts[0] : '';
  const version = parts.length === 2 ? parts[1] : parts[0];

  for (const [name, schema] of Object.entries(schemas)) {
    const gvks = schema['x-kubernetes-group-version-kind'];
    if (!gvks) continue;
    if (gvks.some((g) => g.kind === kind && g.version === version && (g.group ?? '') === group)) {
      return name;
    }
  }

  // Fallback for aggregated apiservers that omit the GVK extension. The schema
  // name still encodes the version (io.k8s.api.apps.v1.Deployment), so a name
  // carrying a DIFFERENT version is rejected rather than silently answering with
  // the wrong shape. Names that encode no version at all are accepted, which is
  // what makes this work for CRDs.
  const suffix = `.${kind}`;
  for (const name of Object.keys(schemas)) {
    if (!name.endsWith(suffix)) continue;
    const embedded = name.slice(0, -suffix.length).split('.').pop();
    if (embedded && VERSION_SEGMENT.test(embedded) && embedded !== version) continue;
    return name;
  }
  return null;
}

/** Matches a Kubernetes API version segment: v1, v2beta3, v1alpha1. */
const VERSION_SEGMENT = /^v\d+(?:(?:alpha|beta)\d+)?$/;

/** Extract the schema name a `$ref` points at, or null for external refs. */
function refTarget(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

/** Collect every `$ref` appearing anywhere inside one schema node. */
function collectRefs(schema: OpenApiSchema, out: Set<string>): void {
  if (schema.$ref) {
    const target = refTarget(schema.$ref);
    if (target) out.add(target);
  }
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) collectRefs(child, out);
  }
  if (schema.items) collectRefs(schema.items, out);
  if (schema.allOf) {
    for (const child of schema.allOf) collectRefs(child, out);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    collectRefs(schema.additionalProperties, out);
  }
}

/**
 * Breadth-first closure of everything reachable from `root`.
 *
 * Cyclic schemas are ordinary in Kubernetes (JSONSchemaProps refers to itself),
 * so the visited set is what terminates this, not a depth limit.
 */
export function pruneClosure(
  schemas: Record<string, OpenApiSchema>,
  root: string,
): Record<string, OpenApiSchema> {
  const out: Record<string, OpenApiSchema> = {};
  const queue = [root];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (name in out) continue;
    const schema = schemas[name];
    if (!schema) continue;
    out[name] = schema;

    const refs = new Set<string>();
    collectRefs(schema, refs);
    for (const ref of refs) {
      if (!(ref in out)) queue.push(ref);
    }
  }

  return out;
}
