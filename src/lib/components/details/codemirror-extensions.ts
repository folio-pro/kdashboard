import type { CodeMirrorModules } from "$lib/utils/codemirror-lazy";
import type { Extension } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { buildEditorTheme } from "./codemirror-theme";
import { dirtyDiff, dirtyDiffCompartment } from "./diff-tracking";
import { k8sIndentGuides, k8sSemanticHighlight } from "./yaml-decorations";

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
 *
 * `namespace` scopes the cluster-backed value suggestions (which ConfigMaps and
 * Secrets exist); it is fixed per editor because YamlEditor destroys and
 * recreates the view whenever the selected resource changes.
 */
export function getExtensions(
  modules: CodeMirrorModules,
  originalYaml: string,
  onDocChange: (content: string) => void,
  readOnly = false,
  namespace = "",
  onDiagnostics?: (errors: number, warnings: number) => void,
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
      if (onDiagnostics) {
        // Linting is debounced, so diagnostics arrive in a later transaction
        // than the edit that produced them — recount on every update, not only
        // on docChanged. There are only ever a handful, so this is cheap.
        let errors = 0;
        let warnings = 0;
        modules.forEachDiagnostic(update.state, (d) => {
          if (d.severity === "error") errors++;
          else if (d.severity === "warning") warnings++;
        });
        onDiagnostics(errors, warnings);
      }
    }),
  ];
  if (!readOnly) {
    exts.push(
      dirtyDiffCompartment!.of(dirtyDiff(modules, originalYaml)),
      modules.k8sAutocompletion(namespace),
      modules.k8sLinter(),
      modules.lintGutter(),
      modules.k8sHoverDocs(),
      modules.closeBrackets(),
      // F8 walks the problem list, matching the convention in most editors.
      modules.keymap.of([{ key: "F8", run: modules.openLintPanel }]),
    );
  }

  // Read-only views get the semantic layer too: a history diff is easier to read
  // with the same structure cues as the editor.
  exts.push(
    k8sSemanticHighlight(modules),
    k8sIndentGuides(modules),
    modules.highlightSelectionMatches(),
  );
  if (readOnly) {
    exts.push(modules.EditorState.readOnly.of(true));
  }
  return exts;
}
