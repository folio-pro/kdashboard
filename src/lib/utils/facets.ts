// The typed-filter grammar: `key:value`, `key:!value`, `key:>3`, `key:<=10`.
//
// Pure string work only — parsing a token, printing one back, comparing two.
// Resolving a key against a table's columns and matching a facet against a
// resource live in components/table/table-filter.ts; the ui store needs only
// this part (to dedupe chips), which is why it is a utility and not a table
// module.

import type { Facet, FacetOp } from "$lib/types/ui";

export type { Facet, FacetOp };

const FACET_RE = /^([A-Za-z][\w-]*):(!?)(>=|<=|>|<)?(\S+)$/;

/** Parse one whitespace-free token; null when it is just text. */
export function parseFacet(token: string): Facet | null {
  const m = FACET_RE.exec(token);
  if (!m) return null;
  const [, key, negate, cmp, value] = m;
  const op: FacetOp = cmp ? (cmp as FacetOp) : negate ? "!:" : ":";
  return { key, op, value };
}

/** The operator as typed: nothing for `:`, `!` for negation, the symbol otherwise. */
export function facetOpLabel(op: FacetOp): string {
  return op === ":" ? "" : op === "!:" ? "!" : op;
}

/** The token that round-trips through `parseFacet`. */
export function facetToText(facet: Facet): string {
  return `${facet.key}:${facetOpLabel(facet.op)}${facet.value}`;
}

/** Identity for dedupe and comparison. */
export function facetKey(facet: Facet): string {
  return `${facet.key} ${facet.op} ${facet.value}`;
}

/** Same facet list, order-insensitive. */
export function sameFacets(a: Facet[], b: Facet[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b.map(facetKey));
  return a.every((f) => bs.has(facetKey(f)));
}
