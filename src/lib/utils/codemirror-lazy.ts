/**
 * Lazy-loads all CodeMirror dependencies in a single dynamic import batch.
 * This keeps the ~426KB CodeMirror chunk out of the main bundle and loads it
 * on demand when the YAML editor tab is first opened.
 */

export interface CodeMirrorModules {
  // @codemirror/state
  EditorState: typeof import("@codemirror/state").EditorState;
  Compartment: typeof import("@codemirror/state").Compartment;
  StateField: typeof import("@codemirror/state").StateField;
  Text: typeof import("@codemirror/state").Text;

  // @codemirror/view
  EditorView: typeof import("@codemirror/view").EditorView;
  keymap: typeof import("@codemirror/view").keymap;
  lineNumbers: typeof import("@codemirror/view").lineNumbers;
  highlightActiveLine: typeof import("@codemirror/view").highlightActiveLine;
  highlightActiveLineGutter: typeof import("@codemirror/view").highlightActiveLineGutter;
  gutter: typeof import("@codemirror/view").gutter;
  GutterMarker: typeof import("@codemirror/view").GutterMarker;

  // @codemirror/lang-yaml
  yaml: typeof import("@codemirror/lang-yaml").yaml;

  // @codemirror/commands
  defaultKeymap: typeof import("@codemirror/commands").defaultKeymap;
  history: typeof import("@codemirror/commands").history;
  undo: typeof import("@codemirror/commands").undo;
  redo: typeof import("@codemirror/commands").redo;
  historyKeymap: typeof import("@codemirror/commands").historyKeymap;

  // @codemirror/language
  syntaxHighlighting: typeof import("@codemirror/language").syntaxHighlighting;
  HighlightStyle: typeof import("@codemirror/language").HighlightStyle;
  indentOnInput: typeof import("@codemirror/language").indentOnInput;
  bracketMatching: typeof import("@codemirror/language").bracketMatching;
  foldGutter: typeof import("@codemirror/language").foldGutter;
  foldKeymap: typeof import("@codemirror/language").foldKeymap;
  indentUnit: typeof import("@codemirror/language").indentUnit;

  // @lezer/highlight
  tags: typeof import("@lezer/highlight").tags;

  // @codemirror/search
  search: typeof import("@codemirror/search").search;
  searchKeymap: typeof import("@codemirror/search").searchKeymap;
  openSearchPanel: typeof import("@codemirror/search").openSearchPanel;

  // @codemirror/merge
  MergeView: typeof import("@codemirror/merge").MergeView;
  computeCharDiff: typeof import("@codemirror/merge").diff;

  // @codemirror/autocomplete
  closeBrackets: typeof import("@codemirror/autocomplete").closeBrackets;
  closeBracketsKeymap: typeof import("@codemirror/autocomplete").closeBracketsKeymap;
  startCompletion: typeof import("@codemirror/autocomplete").startCompletion;

  // @codemirror/lint
  lintGutter: typeof import("@codemirror/lint").lintGutter;

  // yaml-intellisense (also pulls in CodeMirror types)
  k8sAutocompletion: typeof import("$lib/utils/yaml-intellisense").k8sAutocompletion;
  k8sLinter: typeof import("$lib/utils/yaml-intellisense").k8sLinter;
}

let cached: CodeMirrorModules | null = null;

export async function loadCodeMirror(): Promise<CodeMirrorModules> {
  if (cached) return cached;

  const [state, view, langYaml, commands, language, highlight, searchMod, merge, autocomplete, lint, intellisense] =
    await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/lang-yaml"),
      import("@codemirror/commands"),
      import("@codemirror/language"),
      import("@lezer/highlight"),
      import("@codemirror/search"),
      import("@codemirror/merge"),
      import("@codemirror/autocomplete"),
      import("@codemirror/lint"),
      import("$lib/utils/yaml-intellisense"),
    ]);

  cached = {
    EditorState: state.EditorState,
    Compartment: state.Compartment,
    StateField: state.StateField,
    Text: state.Text,

    EditorView: view.EditorView,
    keymap: view.keymap,
    lineNumbers: view.lineNumbers,
    highlightActiveLine: view.highlightActiveLine,
    highlightActiveLineGutter: view.highlightActiveLineGutter,
    gutter: view.gutter,
    GutterMarker: view.GutterMarker,

    yaml: langYaml.yaml,

    defaultKeymap: commands.defaultKeymap,
    history: commands.history,
    undo: commands.undo,
    redo: commands.redo,
    historyKeymap: commands.historyKeymap,

    syntaxHighlighting: language.syntaxHighlighting,
    HighlightStyle: language.HighlightStyle,
    indentOnInput: language.indentOnInput,
    bracketMatching: language.bracketMatching,
    foldGutter: language.foldGutter,
    foldKeymap: language.foldKeymap,
    indentUnit: language.indentUnit,

    tags: highlight.tags,

    search: searchMod.search,
    searchKeymap: searchMod.searchKeymap,
    openSearchPanel: searchMod.openSearchPanel,

    MergeView: merge.MergeView,
    computeCharDiff: merge.diff,

    closeBrackets: autocomplete.closeBrackets,
    closeBracketsKeymap: autocomplete.closeBracketsKeymap,
    startCompletion: autocomplete.startCompletion,

    lintGutter: lint.lintGutter,

    k8sAutocompletion: intellisense.k8sAutocompletion,
    k8sLinter: intellisense.k8sLinter,
  };

  return cached;
}
