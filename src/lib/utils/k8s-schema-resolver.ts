/**
 * Schema path resolution utilities.
 * Functions for navigating the K8s schema tree by YAML path.
 */

import type { SchemaField } from "./k8s-schema-fields.js";
import { K8S_SCHEMAS } from "./k8s-schema-resources.js";

/**
 * Resolve the schema fields at a given YAML path for a resource kind.
 * Path is an array of keys like ["spec", "containers", "0", "ports"].
 */
export function resolveSchemaAtPath(kind: string, path: string[]): Record<string, SchemaField> | null {
  const schema = K8S_SCHEMAS[kind];
  if (!schema) return null;

  let current: Record<string, SchemaField> = schema;

  for (const segment of path) {
    // Skip numeric indices (array items)
    if (/^\d+$/.test(segment)) {
      // Find parent array field and resolve its items
      continue;
    }

    const field = current[segment];
    if (!field) return null;

    if (field.type === "object" && field.children) {
      current = field.children;
    } else if (field.type === "array" && field.items?.type === "object" && field.items.children) {
      current = field.items.children;
    } else {
      return null;
    }
  }

  return current;
}

/**
 * Get the schema field info for a specific key at a path.
 */
export function getFieldInfo(kind: string, path: string[], key: string): SchemaField | null {
  const fields = resolveSchemaAtPath(kind, path);
  if (!fields) return null;
  return fields[key] ?? null;
}
