// Typed filters, applied to a resource table.
//
// Free text alone stops working at a few hundred rows: "everything that is not
// running with more than two restarts" is not a substring. A facet is one
// `key:value` term the user types into the same search box; on space or Enter
// it is lifted out of the text and shown as a chip ahead of it. The grammar
// lives in $lib/utils/facets; this module resolves keys against a table's
// columns and matches facets against resources — pure, so it runs under bun.

import type { Column, Resource } from "$lib/types";
import { parseFacet, type Facet } from "$lib/utils/facets";
import { getCellValue, usageMeter, isUsageColumn, type CellContext } from "./cell-values";

export { parseFacet, facetToText, facetOpLabel, facetKey, sameFacets } from "$lib/utils/facets";
export type { Facet, FacetOp } from "$lib/utils/facets";

/** Short spellings people type at the prompt. */
const KEY_ALIASES: Record<string, string> = {
  ns: "namespace",
  state: "status",
  phase: "status",
  rst: "restarts",
  restart: "restarts",
  cpu: "podCpu",
  mem: "podMemory",
  memory: "podMemory",
};

/** Accessors that work whether or not the type shows them as a column. */
const ALWAYS_RESOLVABLE = new Set(["restarts", "status", "name", "namespace"]);

/**
 * Resolve a typed key to a column key for the current resource type — by
 * column key, by label ("Last Schedule" → lastschedule), or by alias. Null
 * when nothing matches, in which case the token stays plain text.
 */
export function resolveFacetKey(key: string, columns: Column[]): string | null {
  const lower = key.toLowerCase();
  const aliased = KEY_ALIASES[lower];
  const squash = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  for (const col of columns) {
    if (col.key.toLowerCase() === lower) return col.key;
    if (squash(col.label) === squash(lower)) return col.key;
    if (aliased && col.key === aliased) return col.key;
  }
  if (ALWAYS_RESOLVABLE.has(lower)) return lower;
  if (aliased && ALWAYS_RESOLVABLE.has(aliased)) return aliased;
  return null;
}

/**
 * Split committed input into facets (tokens whose key resolves) and the
 * remaining free text. Called on space / Enter, never per keystroke, so a
 * half-typed `sta` or `status:` is left alone.
 */
export function extractFacets(input: string, columns: Column[]): { facets: Facet[]; text: string } {
  const facets: Facet[] = [];
  const rest: string[] = [];
  for (const token of input.split(/\s+/)) {
    if (!token) continue;
    const parsed = parseFacet(token);
    const key = parsed ? resolveFacetKey(parsed.key, columns) : null;
    if (parsed && key) facets.push({ ...parsed, key });
    else rest.push(token);
  }
  return { facets, text: rest.join(" ") };
}

/** True when the token under the caret is a complete term the table understands. */
export function isCommittableFacet(token: string, columns: Column[]): boolean {
  const parsed = parseFacet(token);
  return !!parsed && resolveFacetKey(parsed.key, columns) !== null;
}

/** Leading number of a cell ("14" → 14, "142m" → 142, "1/2" → 1, "-" → NaN). */
function leadingNumber(value: string): number {
  const m = /^-?\d+(\.\d+)?/.exec(value.trim());
  return m ? Number(m[0]) : NaN;
}

/** The text a `:` / `!:` facet matches against for a given column. */
function facetCellValue(resource: Resource, key: string, ctx: CellContext): string {
  // Usage columns match on the raw reading ("142m"); the percent is what the
  // comparison operators read, below.
  if (isUsageColumn(key)) return usageMeter(resource, key, ctx)?.label ?? "";
  return getCellValue(resource, key, ctx);
}

/**
 * The number a `>` / `<` facet compares. Usage columns compare percent of the
 * limit/request — what the bar shows — and are unknown (null) when there is
 * no limit or request to be a percent of, so `cpu:>80` cannot match a pod
 * whose "142m" merely starts with a large number. Other columns use the
 * cell's leading number ("14" → 14, "1/2" → 1, "-" → null).
 */
function facetCellNumber(resource: Resource, key: string, ctx: CellContext): number | null {
  if (isUsageColumn(key)) return usageMeter(resource, key, ctx)?.percent ?? null;
  const n = leadingNumber(getCellValue(resource, key, ctx));
  return Number.isNaN(n) ? null : n;
}

export function matchesFacet(resource: Resource, facet: Facet, ctx: CellContext): boolean {
  switch (facet.op) {
    case ":":
      return facetCellValue(resource, facet.key, ctx).toLowerCase().includes(facet.value.toLowerCase());
    case "!:":
      return !facetCellValue(resource, facet.key, ctx).toLowerCase().includes(facet.value.toLowerCase());
    default: {
      const have = facetCellNumber(resource, facet.key, ctx);
      const want = Number(facet.value);
      if (have === null || Number.isNaN(want)) return false;
      if (facet.op === ">") return have > want;
      if (facet.op === "<") return have < want;
      if (facet.op === ">=") return have >= want;
      return have <= want;
    }
  }
}

/**
 * `ctxFor` builds the per-resource cell context (pod usage, node metrics) a
 * facet on a usage column needs; plain columns ignore it.
 */
export function applyFacets(
  items: Resource[],
  facets: Facet[],
  ctxFor: (resource: Resource) => CellContext,
): Resource[] {
  if (facets.length === 0) return items;
  return items.filter((r) => {
    const ctx = ctxFor(r);
    return facets.every((f) => matchesFacet(r, f, ctx));
  });
}

// ---------------------------------------------------------------------------
// Pod names
// ---------------------------------------------------------------------------

/**
 * Kubernetes random suffixes use this alphabet (no vowels, no 0/1/3) — see
 * k8s.io/apimachinery/pkg/util/rand. A 5-char pod suffix, optionally preceded
 * by the 8–10 char ReplicaSet template hash or a CronJob's numeric job suffix.
 */
const RAND = "[bcdfghjklmnpqrstvwxz2456789]";
const POD_SUFFIX_RE = new RegExp(`(?:-(?:${RAND}{8,10}|\\d{4,}))?-${RAND}{5}$`);

/**
 * `api-gateway-7d4f8b9c5-2xkqp` → { base: "api-gateway", suffix: "-7d4f8b9c5-2xkqp" }.
 * The base is what a human reads; the suffix is what they copy. StatefulSet
 * ordinals (`redis-0`) and hand-named pods come back with an empty suffix.
 */
export function splitPodName(name: string): { base: string; suffix: string } {
  const m = POD_SUFFIX_RE.exec(name);
  if (!m || m.index === 0) return { base: name, suffix: "" };
  return { base: name.slice(0, m.index), suffix: name.slice(m.index) };
}
