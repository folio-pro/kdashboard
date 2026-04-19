import type { CodeMirrorModules } from "$lib/utils/codemirror-lazy";
import type { Extension } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { buildEditorTheme } from "./codemirror-theme";
import { dirtyDiff, dirtyDiffCompartment } from "./diff-tracking";

/** Build the syntax highlight style list using CSS variable colors. */
export function buildHighlightStyles(modules: CodeMirrorModules) {
  return modules.HighlightStyle.define([
    { tag: modules.tags.propertyName, color: "var(--accent)" },
    { tag: modules.tags.string, color: "var(--status-running)" },
    { tag: modules.tags.number, color: "var(--status-succeeded)" },
    { tag: modules.tags.bool, color: "var(--status-pending)" },
    { tag: modules.tags.null, color: "var(--text-muted)" },
    { tag: modules.tags.comment, color: "var(--text-muted)", fontStyle: "italic" },
    { tag: modules.tags.punctuation, color: "var(--text-muted)" },
    { tag: modules.tags.keyword, color: "var(--accent)" },
    { tag: modules.tags.operator, color: "var(--text-muted)" },
    { tag: modules.tags.meta, color: "var(--text-muted)" },
  ]);
}

/** Enter handler: copy indentation from current line, add extra indent after ":" */
export function yamlNewline(view: EditorViewType): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;

  const line = state.doc.lineAt(from);
  const lineText = line.text;

  // Get leading whitespace of current line
  const indentMatch = lineText.match(/^(\s*)/);
  const currentIndent = indentMatch ? indentMatch[1] : "";

  // Check if line ends with ":" (object/array start) -> add extra indent
  const trimmedBeforeCursor = lineText.substring(0, from - line.from).trimEnd();
  const addExtra = trimmedBeforeCursor.endsWith(":");

  const newIndent = addExtra ? currentIndent + "  " : currentIndent;

  view.dispatch({
    changes: { from, to, insert: "\n" + newIndent },
    selection: { anchor: from + 1 + newIndent.length },
  });
  return true;
}

/**
 * Compose all CodeMirror extensions for the YAML editor.
 * When `readOnly` is true the dirty-diff gutter, autocompletion, and linting are omitted.
 */
export function getExtensions(
  modules: CodeMirrorModules,
  originalYaml: string,
  onDocChange: (content: string) => void,
  readOnly = false,
): Extension[] {
  const editorTheme = buildEditorTheme(modules);
  const highlightStyles = buildHighlightStyles(modules);

  const exts: Extension[] = [
    modules.yaml(),
    modules.indentUnit.of("  "),
    editorTheme,
    modules.syntaxHighlighting(highlightStyles),
    modules.lineNumbers(),
    modules.highlightActiveLine(),
    modules.highlightActiveLineGutter(),
    modules.indentOnInput(),
    modules.bracketMatching(),
    modules.foldGutter(),
    modules.history(),
    modules.search(),
    modules.keymap.of([
      // Enter: smart YAML indentation
      { key: "Enter", run: yamlNewline },
      // Cmd+Space / Ctrl+Space to trigger autocomplete
      { key: "Mod-Space", run: modules.startCompletion },
      { key: "Ctrl-Space", run: modules.startCompletion },
      ...modules.closeBracketsKeymap,
      ...modules.defaultKeymap,
      ...modules.historyKeymap,
      ...modules.foldKeymap,
      ...modules.searchKeymap,
    ]),
    modules.EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange(update.state.doc.toString());
      }
    }),
  ];
  if (!readOnly) {
    exts.push(
      dirtyDiffCompartment!.of(dirtyDiff(modules, originalYaml)),
      modules.k8sAutocompletion(),
      modules.k8sLinter(),
      modules.lintGutter(),
      modules.closeBrackets(),
    );
  }
  if (readOnly) {
    exts.push(modules.EditorState.readOnly.of(true));
  }
  return exts;
}
