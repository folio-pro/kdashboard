/**
 * YAML structure analysis for the Kubernetes editor.
 *
 * Two distinct capabilities live here, because the editor needs them under very
 * different conditions:
 *
 *   1. `contextAtOffset` — answers "where is the cursor?" while the user types.
 *      Mid-edit YAML is almost always syntactically invalid (`spec:\n  cont`),
 *      so this walks indentation by hand rather than trusting a parse tree that
 *      may not exist. Used by autocompletion.
 *
 *   2. `rangeOfPath` / `documentsOf` — answer "where does this value live in the
 *      source?" over YAML that already parsed. Backed by the `yaml` package's
 *      CST, which carries exact byte ranges. Used by the linter, which bails out
 *      before schema validation whenever there are syntax errors anyway.
 *
 * Splitting them this way is deliberate: the previous implementation located
 * diagnostics with `regex.exec(doc)`, which returns the FIRST occurrence of a
 * key anywhere in the file — so an invalid `protocol:` in the third port got
 * underlined on the first one.
 */

import { isMap, isPair, isScalar, isSeq, parseAllDocuments, type Document, type Node } from "yaml";

/** One step in a YAML path: a mapping key, or an index into a sequence. */
export type PathSegment = string | number;

export interface YamlContext {
  /** Path of keys/indices from the document root to the cursor. */
  path: PathSegment[];
  /** `kind` of the document the cursor sits in, or null when not yet written. */
  kind: string | null;
  /** `apiVersion` of that same document. */
  apiVersion: string | null;
  /** True when the cursor is on the key side of a mapping entry. */
  isKey: boolean;
  /** When on the value side, the key this value belongs to. */
  currentKey: string | null;
  /** Indentation column the cursor is writing at. */
  indent: number;
  /** Zero-based index of the containing document in a multi-document file. */
  docIndex: number;
  /** True when the cursor line is a sequence entry (`- foo`). */
  inSequenceItem: boolean;
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

/** Number of leading space characters. Tabs are illegal YAML indentation and
 *  are counted as one column each so positions stay in sync with the editor. */
function leadingWidth(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** True for a line whose first non-space character starts a sequence entry. */
function isSequenceItem(line: string): boolean {
  return /^[ \t]*-([ \t]|$)/.test(line);
}

/**
 * Column at which a sequence item's content begins — i.e. just past the dash
 * and the spaces after it. For `  - name: x` that is 4.
 * Returns `indent + 2` for a bare `-` with nothing after it, which is where the
 * user's content will land once they type.
 */
function sequenceContentColumn(line: string): number {
  const m = line.match(/^[ \t]*-([ \t]+)/);
  if (!m) return leadingWidth(line) + 2;
  return m[0].length;
}

/**
 * Extract the mapping key a line declares, ignoring any leading sequence dash.
 * Returns null when the line does not open a `key:` entry.
 *
 * Keys are matched conservatively: a colon only ends a key when followed by
 * whitespace or end-of-line, which is what distinguishes `annotations:` from a
 * value such as `image: registry:5000/app`.
 */
export function keyOfLine(line: string): string | null {
  const withoutDash = line.replace(/^([ \t]*)-([ \t]+)/, "$1$2");
  const m = withoutDash.match(/^[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#][^:]*?)):(?:[ \t]|$)/);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]).trim();
}

/**
 * Offset of the colon that terminates the key on this line, or -1.
 * Quote-aware so that `path: /a:b` and `image: repo:tag` are not mistaken for
 * having two keys.
 */
function keyColonIndex(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return -1;
    if (ch === ":") {
      const next = line[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

/** Split a document into lines plus the absolute offset each line starts at. */
function lineIndex(text: string): { lines: string[]; starts: number[] } {
  const lines = text.split("\n");
  const starts: number[] = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = at;
    at += lines[i].length + 1;
  }
  return { lines, starts };
}

/** Index of the line containing `pos`, clamped into range. */
function lineAt(starts: number[], lines: string[], pos: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (pos < starts[i] + lines[i].length + 1) return i;
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// Cursor context — indentation walk, tolerant of half-typed YAML
// ---------------------------------------------------------------------------

/**
 * Count how many sequence entries at `indent` precede line `from` within the
 * same block, giving the cursor's index inside that sequence.
 */
function sequenceIndexOf(lines: string[], from: number, indent: number): number {
  let count = 0;
  for (let i = from - 1; i >= 0; i--) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const ind = leadingWidth(line);
    if (ind > indent) continue; // content nested inside a previous entry
    if (ind < indent) break; // left the sequence's block
    if (isSequenceItem(line)) count++;
    else break; // a plain key at this indent means a different block
  }
  return count;
}

/** Start line of the YAML document containing `lineIdx` (multi-doc `---`). */
function documentStartLine(lines: string[], lineIdx: number): number {
  for (let i = lineIdx; i >= 0; i--) {
    if (/^---(\s|$)/.test(lines[i])) return i + 1;
  }
  return 0;
}

/** How many `---` separators precede `lineIdx`. */
function documentIndexOf(lines: string[], lineIdx: number): number {
  let n = 0;
  for (let i = 0; i < lineIdx && i < lines.length; i++) {
    if (/^---(\s|$)/.test(lines[i])) n++;
  }
  // A leading `---` opens the first document rather than starting a second one.
  if (n > 0 && /^---(\s|$)/.test(lines[0])) n--;
  return n;
}

/** Read a root-level scalar field (`kind`, `apiVersion`) of one document. */
function rootField(lines: string[], startLine: number, field: string): string | null {
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (i > startLine && /^---(\s|$)/.test(line)) break;
    if (leadingWidth(line) !== 0) continue;
    const m = line.match(new RegExp(`^${field}:[ \\t]*(\\S.*?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Resolve what the cursor is pointing at. Never throws and never depends on the
 * document parsing cleanly — this runs on every keystroke.
 */
export function contextAtOffset(text: string, pos: number): YamlContext {
  const { lines, starts } = lineIndex(text);
  const clamped = Math.max(0, Math.min(pos, text.length));
  const lineIdx = lineAt(starts, lines, clamped);
  const line = lines[lineIdx] ?? "";
  const col = clamped - starts[lineIdx];

  const docStart = documentStartLine(lines, lineIdx);
  const docIndex = documentIndexOf(lines, lineIdx);
  const kind = rootField(lines, docStart, "kind");
  const apiVersion = rootField(lines, docStart, "apiVersion");

  // Indentation the cursor is writing at. On a whitespace-only line the cursor
  // column *is* the indent the user intends, which is how completions work on a
  // freshly opened line.
  const ws = leadingWidth(line);
  const indent = line.trim() === "" ? Math.max(ws, col) : ws;

  const before = line.slice(0, col);
  const colonIdx = keyColonIndex(before);
  const isKey = colonIdx === -1;
  const currentKey = isKey ? null : keyOfLine(line);
  const inSequenceItem = isSequenceItem(line);

  const path = buildPath(lines, lineIdx, indent, docStart, inSequenceItem);

  return { path, kind, apiVersion, isKey, currentKey, indent, docIndex, inSequenceItem };
}

/**
 * Walk upwards from the cursor line collecting the enclosing keys and sequence
 * indices.
 *
 * Sequence entries are the part the old regex walker dropped: `- name: main` is
 * not a path segment named `name`, it is index N of the sequence its dash sits
 * in, and the keys beside it live in that entry's inner mapping.
 */
export function buildPath(
  lines: string[],
  lineIdx: number,
  cursorIndent: number,
  docStart = 0,
  cursorIsSequenceItem = false,
): PathSegment[] {
  const path: PathSegment[] = [];
  let seek = cursorIndent;

  // A cursor sitting on its own `- ` belongs to the sequence declared by the
  // key above it. The `+ 1` matters: YAML allows the dash at the declaring
  // key's own column, so a bound of exactly the dash indent would skip that key.
  if (cursorIsSequenceItem && lines[lineIdx] !== undefined) {
    seek = leadingWidth(lines[lineIdx]) + 1;
  }

  for (let i = lineIdx - 1; i >= docStart; i--) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    if (/^---(\s|$)/.test(line)) break;

    const ind = leadingWidth(line);
    if (ind >= seek) continue; // sibling or deeper — not an ancestor

    if (isSequenceItem(line)) {
      const contentCol = sequenceContentColumn(line);
      if (contentCol <= seek) {
        // The cursor lives inside this entry's mapping. Search on from one
        // column past the dash, not from the dash itself: both of these are
        // valid, and in the second the declaring key shares the dash's column,
        // so a bound of `ind` would skip it.
        //
        //     containers:          containers:
        //       - name: main       - name: main
        path.unshift(sequenceIndexOf(lines, i, ind));
        seek = ind + 1;
      }
      continue;
    }

    const key = keyOfLine(line);
    if (key !== null) {
      path.unshift(key);
      seek = ind;
    }

    if (seek === 0) break;
  }

  return path;
}

// ---------------------------------------------------------------------------
// Source ranges — CST-backed, exact
// ---------------------------------------------------------------------------

/** Parse every document in the text. Errors are preserved on each document. */
export function documentsOf(text: string): Document.Parsed[] {
  return parseAllDocuments(text, { keepSourceTokens: true });
}

export interface SourceRange {
  from: number;
  to: number;
}

/** Node range excluding trailing whitespace/comments (`range[1]`, not `[2]`). */
function rangeOfNode(node: unknown): SourceRange | null {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  if (!r) return null;
  return { from: r[0], to: r[1] };
}

/**
 * Resolve a path to its exact source range within one parsed document.
 *
 * `target` selects which half of a mapping entry to point at: "key" underlines
 * just the field name (right for "unknown field"), "value" underlines what the
 * user wrote (right for "invalid enum value"). Falls back to whichever half
 * exists.
 */
export function rangeOfPath(
  doc: Document.Parsed,
  path: PathSegment[],
  target: "key" | "value" = "value",
): SourceRange | null {
  let node: unknown = doc.contents;
  let keyNode: unknown = null;

  for (const segment of path) {
    if (isSeq(node)) {
      const idx = typeof segment === "number" ? segment : Number(segment);
      if (!Number.isInteger(idx)) return null;
      const item = node.items[idx];
      if (item === undefined) return null;
      keyNode = null;
      node = item;
      continue;
    }

    if (isMap(node)) {
      const pair = node.items.find(
        (p) => isPair(p) && isScalar(p.key) && String(p.key.value) === String(segment),
      );
      if (!pair || !isPair(pair)) return null;
      keyNode = pair.key;
      node = pair.value;
      continue;
    }

    return null;
  }

  if (target === "key" && keyNode) {
    const r = rangeOfNode(keyNode);
    if (r) return r;
  }

  const valueRange = rangeOfNode(node);
  if (valueRange) return valueRange;

  // An entry written as `key:` with nothing after it has no value node; point
  // at the key so the diagnostic still lands on the right line.
  return rangeOfNode(keyNode);
}

/**
 * Range spanning a mapping entry's key AND value, used when a diagnostic is
 * about the pair as a whole.
 */
export function rangeOfEntry(doc: Document.Parsed, path: PathSegment[]): SourceRange | null {
  const key = rangeOfPath(doc, path, "key");
  const value = rangeOfPath(doc, path, "value");
  if (!key) return value;
  if (!value) return key;
  return { from: Math.min(key.from, value.from), to: Math.max(key.to, value.to) };
}

/** Walk every scalar leaf and mapping entry of a document, yielding paths. */
export function walkPaths(
  node: unknown,
  visit: (path: PathSegment[], value: unknown) => void,
  path: PathSegment[] = [],
  depth = 0,
): void {
  if (depth > 32) return;

  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isPair(pair) || !isScalar(pair.key)) continue;
      const next = [...path, String(pair.key.value)];
      visit(next, pair.value);
      walkPaths(pair.value, visit, next, depth + 1);
    }
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item, idx) => {
      const next = [...path, idx];
      visit(next, item);
      walkPaths(item, visit, next, depth + 1);
    });
  }
}

/** Plain JS value of a node, or the node itself when already plain. */
export function plainValue(node: unknown): unknown {
  if (isScalar(node)) return node.value;
  if (node && typeof (node as Node).toJSON === "function") {
    return (node as Node).toJSON();
  }
  return node;
}

// Test exports — internals worth pinning without widening the public surface.
export {
  leadingWidth as _leadingWidth,
  isSequenceItem as _isSequenceItem,
  sequenceContentColumn as _sequenceContentColumn,
  keyColonIndex as _keyColonIndex,
  sequenceIndexOf as _sequenceIndexOf,
  documentStartLine as _documentStartLine,
  documentIndexOf as _documentIndexOf,
  rootField as _rootField,
};
