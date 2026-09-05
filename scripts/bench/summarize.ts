// Median of N benchmark JSON documents with the same shape (numbers are
// reduced element-wise, everything else is taken from the first run).
//
//   bun scripts/bench/summarize.ts out.json run1.json run2.json run3.json
import { readFileSync, writeFileSync } from "node:fs";

type Json = number | string | boolean | null | Json[] | { [k: string]: Json };

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 100) / 100;
}

export function mergeMedian(docs: Json[]): Json {
  const first = docs[0];
  if (typeof first === "number") {
    return median(docs.filter((d): d is number => typeof d === "number"));
  }
  if (Array.isArray(first)) {
    return first.map((_, i) => mergeMedian(docs.map((d) => (d as Json[])[i])));
  }
  if (first && typeof first === "object") {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(first)) {
      const vals = docs
        .filter((d) => d && typeof d === "object" && !Array.isArray(d) && key in d)
        .map((d) => (d as { [k: string]: Json })[key]);
      out[key] = mergeMedian(vals);
    }
    return out;
  }
  return first;
}

if (import.meta.main) {
  const [out, ...inputs] = process.argv.slice(2);
  if (!out || inputs.length === 0) {
    console.error("usage: summarize.ts <out.json> <run.json>...");
    process.exit(2);
  }
  const docs = inputs.map((p) => JSON.parse(readFileSync(p, "utf8")) as Json);
  const merged = mergeMedian(docs) as { [k: string]: Json };
  merged.meta = { runs: inputs.length, sources: inputs.map((p) => p.split("/").pop() ?? p) };
  writeFileSync(out, JSON.stringify(merged, null, 2));
}
