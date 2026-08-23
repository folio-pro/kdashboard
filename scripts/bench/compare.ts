// Diff two benchmark JSON documents (frontend or e2e) as a markdown table.
//
//   bun scripts/bench/compare.ts before.json after.json
//
// Walks both documents, prints every numeric leaf side by side with the delta.
// Negative deltas are improvements for everything except the few "higher is
// better" metrics listed in HIGHER_IS_BETTER.
import { readFileSync } from "node:fs";

type Json = number | string | boolean | null | Json[] | { [k: string]: Json };

const HIGHER_IS_BETTER = [/fps$/i, /rendered$/i, /renderedRows$/i, /itemCount$/i, /count$/i, /total$/i];
const SKIP = [/^meta\./, /\.samples\./, /\.samples$/, /timestamp/, /DomNodes$/, /domNodes$/];

function flatten(doc: Json, prefix = "", out = new Map<string, number>()): Map<string, number> {
  if (typeof doc === "number") out.set(prefix, doc);
  else if (Array.isArray(doc)) doc.forEach((d, i) => flatten(d, `${prefix}[${i}]`, out));
  else if (doc && typeof doc === "object") {
    for (const [k, v] of Object.entries(doc)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function fmt(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
}

export function compare(before: Json, after: Json): string {
  const a = flatten(before);
  const b = flatten(after);
  const rows: string[] = [];
  for (const [key, x] of a) {
    if (SKIP.some((re) => re.test(key))) continue;
    const y = b.get(key);
    if (y === undefined) continue;
    const higher = HIGHER_IS_BETTER.some((re) => re.test(key));
    const delta = y - x;
    const pct = x !== 0 ? (delta / Math.abs(x)) * 100 : 0;
    const better = higher ? delta > 0 : delta < 0;
    const mark = Math.abs(pct) < 3 ? "·" : better ? "✓" : "✗";
    rows.push(`| ${key} | ${fmt(x)} | ${fmt(y)} | ${delta >= 0 ? "+" : ""}${fmt(delta)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% ${mark} |`);
  }
  return ["| metric | before | after | Δ | Δ% |", "|---|---:|---:|---:|---:|", ...rows].join("\n");
}

if (import.meta.main) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("usage: compare.ts <before.json> <after.json>");
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as Json;
  const after = JSON.parse(readFileSync(afterPath, "utf8")) as Json;
  console.log(compare(before, after));
}
