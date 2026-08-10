/**
 * Semantic decorations for the Kubernetes YAML editor.
 *
 * WHY DECORATIONS AND NOT MORE HIGHLIGHT TAGS: @lezer/yaml emits exactly ten
 * highlight tags (propertyName, string, number, bool, null, comment, keyword,
 * meta, punctuation, operator) and buildHighlightStyles already maps all ten.
 * Adding entries to that style list cannot make a Secret's base64 blob recede or
 * a Deployment's top-level structure stand out, because the grammar does not
 * distinguish them. Everything below therefore works on the text itself.
 *
 * CodeMirror is reached through `modules` rather than imported, so this file
 * stays out of the main bundle — the same rule diff-tracking.ts follows.
 *
 * Only visible ranges are scanned, so cost is bounded by viewport height rather
 * than document length.
 */

import type { CodeMirrorModules } from "$lib/utils/codemirror-lazy";
import type { Extension } from "@codemirror/state";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Keys that carry a resource's structure, rather than its data. */
const ROOT_KEYS = new Set([
  "apiVersion",
  "kind",
  "metadata",
  "spec",
  "status",
  "data",
  "stringData",
  "binaryData",
  "type",
  "rules",
  "subjects",
  "roleRef",
]);

/** `key:` at the start of a line, capturing indentation and the key. */
const KEY_AT_LINE_START = /^([ \t]*)([A-Za-z][\w.\-/]*):(?:[ \t]|$)/;
/** A container image reference. */
const IMAGE_VALUE = /^([ \t]*)image:[ \t]+(\S+)[ \t]*$/;
/** YAML anchors and aliases. */
const ANCHOR_OR_ALIAS = /(?:^|[ \t])([&*][\w.\-]+)/g;
/** A long unbroken token — in practice the base64 payload of a Secret. */
const OPAQUE_VALUE = /^[ \t]+[\w.\-]+:[ \t]+([A-Za-z0-9+/]{40,}={0,2})[ \t]*$/;

const INDENT_UNIT = 2;

/** Index of the colon that introduces a tag, ignoring a registry port. */
function lastTagColon(value: string): number {
  const colon = value.lastIndexOf(":");
  if (colon === -1) return -1;
  // `registry:5000/app` — a colon followed by a slash is a port, not a tag.
  return value.indexOf("/", colon) === -1 ? colon : -1;
}

/**
 * True when the line sits inside a `data:`/`binaryData:`/`stringData:` block,
 * whose values are payloads nobody reads and which otherwise dominate a Secret.
 */
function insideDataBlock(view: EditorView, lineNumber: number): boolean {
  for (let n = lineNumber - 1; n >= 1; n--) {
    const text = view.state.doc.line(n).text;
    if (text.trim() === "" || text.trimStart().startsWith("#")) continue;
    const indent = text.length - text.trimStart().length;
    if (indent > 0) continue;
    return /^(data|binaryData|stringData):/.test(text);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/**
 * Kubernetes-aware emphasis: document separators, top-level structure keys,
 * image tags, anchors, and receding base64 payloads.
 */
export function k8sSemanticHighlight(modules: CodeMirrorModules): Extension {
  const { Decoration, RangeSetBuilder, ViewPlugin } = modules;

  const rootKeyMark = Decoration.mark({ class: "cm-k8s-root-key" });
  const separatorMark = Decoration.mark({ class: "cm-k8s-doc-separator" });
  const imageTagMark = Decoration.mark({ class: "cm-k8s-image-tag" });
  const opaqueMark = Decoration.mark({ class: "cm-k8s-opaque" });
  const anchorMark = Decoration.mark({ class: "cm-k8s-anchor" });

  function build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<import("@codemirror/view").Decoration>();

    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        const text = line.text;

        if (/^---(\s|$)/.test(text)) {
          builder.add(line.from, line.from + 3, separatorMark);
        } else {
          const key = text.match(KEY_AT_LINE_START);
          if (key && key[1].length === 0 && ROOT_KEYS.has(key[2])) {
            builder.add(line.from, line.from + key[2].length, rootKeyMark);
          }

          const image = text.match(IMAGE_VALUE);
          if (image) {
            const value = image[2];
            const valueStart = line.from + text.length - value.length;
            // Emphasise the tag or digest: the part that decides what actually
            // runs, and the part most often left off.
            const digest = value.lastIndexOf("@");
            const sep = digest !== -1 ? digest : lastTagColon(value);
            if (sep > 0) {
              builder.add(valueStart + sep, valueStart + value.length, imageTagMark);
            }
          }

          const opaque = text.match(OPAQUE_VALUE);
          if (opaque && insideDataBlock(view, line.number)) {
            const payload = opaque[1];
            const start = line.from + text.length - payload.length;
            builder.add(start, start + payload.length, opaqueMark);
          }

          ANCHOR_OR_ALIAS.lastIndex = 0;
          let anchor: RegExpExecArray | null;
          while ((anchor = ANCHOR_OR_ALIAS.exec(text)) !== null) {
            const start = line.from + anchor.index + anchor[0].indexOf(anchor[1]);
            builder.add(start, start + anchor[1].length, anchorMark);
          }
        }

        if (line.to >= to) break;
        pos = line.to + 1;
      }
    }

    return builder.finish();
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

// ---------------------------------------------------------------------------
// Indentation guides
// ---------------------------------------------------------------------------

/**
 * One vertical rule per indentation level.
 *
 * Depth is published as a CSS custom property and drawn by a repeating gradient
 * in the editor theme, which is far cheaper than a widget per level per line.
 * Blank lines inherit the depth of the nearest non-blank line above, so guides
 * do not break across the gaps people leave between blocks.
 */
export function k8sIndentGuides(modules: CodeMirrorModules): Extension {
  const { Decoration, RangeSetBuilder, ViewPlugin } = modules;

  function build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<import("@codemirror/view").Decoration>();

    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      let carried = 0;

      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        const text = line.text;

        let depth: number;
        if (text.trim() === "") {
          depth = carried;
        } else {
          const indent = text.length - text.trimStart().length;
          depth = Math.floor(indent / INDENT_UNIT);
          carried = depth;
        }

        if (depth > 0) {
          builder.add(
            line.from,
            line.from,
            Decoration.line({
              class: "cm-k8s-indent",
              attributes: { style: `--k8s-indent-depth:${depth}` },
            }),
          );
        }

        if (line.to >= to) break;
        pos = line.to + 1;
      }
    }

    return builder.finish();
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

// Test exports
export {
  lastTagColon as _lastTagColon,
  ROOT_KEYS as _ROOT_KEYS,
  KEY_AT_LINE_START as _KEY_AT_LINE_START,
  IMAGE_VALUE as _IMAGE_VALUE,
  OPAQUE_VALUE as _OPAQUE_VALUE,
  INDENT_UNIT as _INDENT_UNIT,
};
