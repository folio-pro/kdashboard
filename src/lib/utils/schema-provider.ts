/**
 * One lookup interface over every schema source the editor can consult.
 *
 * Autocompletion and linting ask a provider what fields exist at a YAML path;
 * they never learn whether the answer came from the cluster's OpenAPI document
 * or from the hand-written table. The cascade is:
 *
 *   cluster OpenAPI (exact, covers CRDs)  ->  static K8S_SCHEMAS (12 kinds)
 *
 * `authoritative` is the one thing callers must respect. Only an OpenAPI-backed
 * provider knows the complete set of valid fields, so only it may be used to
 * warn "unknown field". Flagging unknown fields against the static table would
 * fire on almost every real manifest.
 */

import { K8S_SCHEMAS, KIND_API_VERSIONS } from "./k8s-schema";
import type { SchemaField } from "./k8s-schema-fields";
import { resolveSchemaAtPath } from "./k8s-schema-resolver";
import {
  fetchOpenApiSchema,
  fieldAtPath,
  fieldsAtPath,
  peekOpenApiSchema,
  type OpenApiSchemaResult,
} from "./openapi-schema";
import type { PathSegment } from "./yaml-ast";

export interface SchemaProvider {
  /** Resource kind this provider describes, or null when none is known. */
  kind: string | null;
  /** Where the schema came from, for diagnostics and the editor status line. */
  source: "openapi" | "static" | "none";
  /** True only when the schema lists every valid field for this kind. */
  authoritative: boolean;
  /** Child fields at a path; null when the path is not described. */
  fieldsAt(path: PathSegment[]): Record<string, SchemaField> | null;
  /** The field describing the value at a path; null when not described. */
  fieldAt(path: PathSegment[]): SchemaField | null;
}

/** Provider that knows nothing — used before a kind is written. */
export const EMPTY_PROVIDER: SchemaProvider = {
  kind: null,
  source: "none",
  authoritative: false,
  fieldsAt: () => null,
  fieldAt: () => null,
};

// ---------------------------------------------------------------------------
// Static table
// ---------------------------------------------------------------------------

function staticProvider(kind: string): SchemaProvider {
  return {
    kind,
    source: "static",
    // The table covers 12 kinds shallowly; treating it as complete would flood
    // the editor with false "unknown field" warnings.
    authoritative: false,
    fieldsAt(path) {
      const fields = resolveSchemaAtPath(kind, path);
      if (fields && Object.keys(fields).length > 0) return fields;

      // A path may descend into a subtree the table does not model (a container
      // inside a Job's pod template, say). Retrying against shorter prefixes
      // recovers useful suggestions instead of going silent.
      for (let trim = 1; trim < path.length; trim++) {
        const shorter = resolveSchemaAtPath(kind, path.slice(0, path.length - trim));
        if (shorter && Object.keys(shorter).length > 0) return shorter;
      }
      return null;
    },
    fieldAt(path) {
      if (path.length === 0) return null;
      const key = path[path.length - 1];
      if (typeof key !== "string") return null;
      const parent = resolveSchemaAtPath(kind, path.slice(0, -1));
      return parent?.[key] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Cluster OpenAPI
// ---------------------------------------------------------------------------

function openApiProvider(kind: string, result: OpenApiSchemaResult): SchemaProvider {
  return {
    kind,
    source: "openapi",
    authoritative: true,
    fieldsAt: (path) => fieldsAtPath(result, path),
    fieldAt: (path) => fieldAtPath(result, path),
  };
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/**
 * Best apiVersion to ask the cluster about: what the document declares, else
 * the conventional one for this kind.
 */
function resolveApiVersion(kind: string, declared: string | null): string | null {
  if (declared && declared.trim() !== "") return declared.trim();
  return KIND_API_VERSIONS[kind]?.[0] ?? null;
}

/** Fallback chain once the cluster has been ruled out. */
function offlineProvider(kind: string): SchemaProvider {
  return kind in K8S_SCHEMAS ? staticProvider(kind) : EMPTY_PROVIDER;
}

/**
 * Provider for a kind, awaiting the cluster fetch on first use.
 *
 * Subsequent calls for the same kind resolve from cache, so the per-keystroke
 * cost after the first lookup is a map read.
 */
export async function loadSchemaProvider(
  kind: string | null,
  apiVersion: string | null,
): Promise<SchemaProvider> {
  if (!kind) return EMPTY_PROVIDER;

  const version = resolveApiVersion(kind, apiVersion);
  if (!version) return offlineProvider(kind);

  const result = await fetchOpenApiSchema(version, kind);
  return result.available ? openApiProvider(kind, result) : offlineProvider(kind);
}

/**
 * Provider available right now, without awaiting.
 *
 * Returns the cluster schema when it is already cached, otherwise the static
 * fallback — and kicks off the fetch so the next call can do better. Used by the
 * linter, which must produce diagnostics synchronously on every document change.
 */
export function peekSchemaProvider(kind: string | null, apiVersion: string | null): SchemaProvider {
  if (!kind) return EMPTY_PROVIDER;

  const version = resolveApiVersion(kind, apiVersion);
  if (!version) return offlineProvider(kind);

  const cached = peekOpenApiSchema(version, kind);
  if (cached) {
    return cached.available ? openApiProvider(kind, cached) : offlineProvider(kind);
  }

  // Warm the cache for the next pass; the promise is intentionally unawaited.
  void fetchOpenApiSchema(version, kind);
  return offlineProvider(kind);
}

// Test exports
export { staticProvider as _staticProvider, openApiProvider as _openApiProvider };
