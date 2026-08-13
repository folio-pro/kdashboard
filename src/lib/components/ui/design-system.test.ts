import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards on the design system's two hard rules. Both were broken in the tree
 * before the system was written down, and both fail silently — a raw palette
 * colour looks correct on the default dark theme and only falls apart on the
 * five light presets, and an off-scale radius reads as "nearly right" forever.
 */

const SRC = join(import.meta.dir, "../../..");

/**
 * `.ts` counts as much as `.svelte`: the variant maps that decide what every
 * button and badge in the app looks like live in the `variants.ts` files, so a
 * scanner that only reads markup exempts exactly the files with the widest
 * blast radius. This file is skipped because it necessarily contains the very
 * tokens it forbids.
 */
const SELF = "design-system.test.ts";

function styledFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      styledFiles(path, acc);
    } else if ((entry.endsWith(".svelte") || entry.endsWith(".ts")) && entry !== SELF) {
      acc.push(path);
    }
  }
  return acc;
}

const files = styledFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  source: readFileSync(path, "utf8"),
}));

/** Strip comments so prose about the rules doesn't trip the rules. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("design system", () => {
  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses no raw Tailwind palette colours", () => {
    const palette =
      /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/g;

    const offenders = files
      .map((f) => ({ path: f.path, hits: code(f.source).match(palette) ?? [] }))
      .filter((f) => f.hits.length > 0)
      .map((f) => `${f.path}: ${[...new Set(f.hits)].join(", ")}`);

    // Theme variables only — the palette is fixed to a dark background and
    // inverts unreadably on github-light, solarized-light and friends.
    expect(offenders).toEqual([]);
  });

  it("uses no bare `rounded` outside the radius scale", () => {
    // The scale is sm · md · lg · xl · full. Bare `rounded` is the Tailwind
    // default that crept in, not a step anybody chose.
    //
    // Scanned as a token rather than inside `class="…"`: half this codebase
    // builds its class list with `cn(…)`, and an attribute-anchored regex
    // silently exempts exactly the files most likely to drift.
    const bare = /(?<![\w-])rounded(?![\w-])/g;

    const offenders = files
      .map((f) => ({ path: f.path, count: (code(f.source).match(bare) ?? []).length }))
      .filter((f) => f.count > 0)
      .map((f) => `${f.path} (${f.count})`);

    expect(offenders).toEqual([]);
  });

  it("assembles no Tailwind arbitrary value at runtime", () => {
    // Tailwind matches class names as literal text in the source. A bracketed
    // utility whose contents are interpolated is a name the scanner never
    // sees, so its rule is simply missing from the stylesheet — silently, and
    // only at runtime. `tones.ts` shipped `[--tone:${value}]` this way and the
    // whole control bar rendered colourless.
    //
    // Interpolation is fine anywhere else in a class list (`h-${n}` is a
    // different mistake and a rarer one); this looks only for the brackets.
    // A class name has no spaces in it, which is also what keeps the ANSI
    // escapes in TerminalView (`\x1b[31mError: ${…}`) out of the net.
    const runtimeArbitrary = /`[^`]*\[[^\]`\s]*\$\{/g;

    const offenders = files
      .map((f) => ({ path: f.path, hits: code(f.source).match(runtimeArbitrary) ?? [] }))
      .filter((f) => f.hits.length > 0)
      .map((f) => `${f.path}: ${f.hits.join(", ")}`);

    // Pass the value through an inline `style` (see `toneStyle`) or spell each
    // class out in full — one literal per case is what the scanner reads.
    expect(offenders).toEqual([]);
  });
});
