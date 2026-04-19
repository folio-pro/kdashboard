import type { CodeMirrorModules } from "$lib/utils/codemirror-lazy";
import type { Extension } from "@codemirror/state";
import type { GutterMarker as GutterMarkerType } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Dirty-diff gutter markers (VS Code-style change indicators)
// ---------------------------------------------------------------------------

export type ChangeKind = "added" | "modified" | "deleted";

let addedMarker: GutterMarkerType | null = null;
let modifiedMarker: GutterMarkerType | null = null;
let deletedMarker: GutterMarkerType | null = null;

/**
 * The compartment used to reconfigure the dirty-diff extension when the
 * baseline (originalYaml) changes after a save.
 * Initialised lazily via `initDiffMarkers()`.
 */
export let dirtyDiffCompartment: InstanceType<typeof import("@codemirror/state").Compartment> | null = null;

/** Must be called once after CodeMirror modules are loaded. */
export function initDiffMarkers(modules: CodeMirrorModules): void {
  if (addedMarker) return; // already initialized

  class DiffGutterMarker extends modules.GutterMarker {
    kind: ChangeKind;
    override elementClass: string;
    constructor(kind: ChangeKind) {
      super();
      this.kind = kind;
      this.elementClass = `cm-dirty-${kind}`;
    }
    eq(other: DiffGutterMarker) {
      return this.kind === other.kind;
    }
  }

  addedMarker = new DiffGutterMarker("added");
  modifiedMarker = new DiffGutterMarker("modified");
  deletedMarker = new DiffGutterMarker("deleted");
  dirtyDiffCompartment = new modules.Compartment();
}

/**
 * Build the dirty-diff extension pair (state field + gutter) that compares
 * the current editor doc against the given `original` text.
 */
export function dirtyDiff(modules: CodeMirrorModules, original: string): Extension[] {
  function computeChangedLines(doc: InstanceType<typeof modules.Text>): Map<number, ChangeKind> {
    const currentStr = doc.toString();
    const raw = modules.computeCharDiff(original, currentStr, { scanLimit: 500 });
    const lines = new Map<number, ChangeKind>();
    for (const c of raw) {
      const hasOrig = c.toA > c.fromA;
      const hasCurrent = c.toB > c.fromB;
      const kind: ChangeKind = !hasOrig ? "added" : !hasCurrent ? "deleted" : "modified";

      if (hasCurrent) {
        const fromLine = doc.lineAt(c.fromB).number;
        const toLine = doc.lineAt(c.toB - 1).number + 1;
        for (let n = fromLine; n < toLine; n++) lines.set(n, kind);
      } else {
        const line = c.fromB < doc.length ? doc.lineAt(c.fromB).number : doc.lines;
        if (!lines.has(line)) lines.set(line, "deleted");
      }
    }
    return lines;
  }

  const diffField = modules.StateField.define<Map<number, ChangeKind>>({
    create(state) {
      return computeChangedLines(state.doc);
    },
    update(value, tr) {
      if (tr.docChanged) return computeChangedLines(tr.state.doc);
      return value;
    },
  });

  const diffGutter = modules.gutter({
    class: "cm-dirty-diff-gutter",
    lineMarker(view, line) {
      const lineNum = view.state.doc.lineAt(line.from).number;
      const kind = view.state.field(diffField).get(lineNum);
      if (!kind) return null;
      return kind === "added"
        ? addedMarker!
        : kind === "modified"
          ? modifiedMarker!
          : deletedMarker!;
    },
  });

  return [diffField, diffGutter];
}
