// Shared JSON-coercion primitives for the topology + diagnostics handlers.
//
// k8s list/object bodies arrive as loose JSON; these are the typed accessors
// both the graph-building and the diagnostics code use to read them safely.

/** Loose JSON object alias — k8s items are serialized to plain JSON. */
export type JsonValue = unknown;
export type JsonObject = Record<string, JsonValue>;

export function asObject(v: JsonValue): JsonObject | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;
}
export function asArray(v: JsonValue): JsonValue[] | undefined {
  return Array.isArray(v) ? (v as JsonValue[]) : undefined;
}
export function asString(v: JsonValue): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function asBool(v: JsonValue): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
export function asNumber(v: JsonValue): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Extract the `.items` array from a client-node list response as plain JSON. */
export function itemsOf(resp: unknown): JsonValue[] {
  const obj = asObject(resp);
  if (!obj) return [];
  const items = asArray(obj['items']);
  return items ?? [];
}
