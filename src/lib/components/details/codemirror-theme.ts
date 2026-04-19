import type { CodeMirrorModules } from "$lib/utils/codemirror-lazy";

/** Build the CodeMirror editor theme using CSS variables from the app theme. */
export function buildEditorTheme(modules: CodeMirrorModules) {
  return modules.EditorView.theme({
    "&": {
      backgroundColor: "var(--bg-primary)",
      color: "var(--text-primary)",
      fontSize: "12px",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
      caretColor: "var(--accent)",
      padding: "8px 0",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-secondary)",
      color: "var(--text-muted)",
      border: "none",
      borderRight: "1px solid var(--border-color)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 12px",
      fontSize: "10px",
      minWidth: "32px",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--bg-secondary)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--bg-tertiary)",
    },
    ".cm-selectionBackground": {
      backgroundColor: "var(--accent) !important",
      opacity: "0.2",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--accent) !important",
      opacity: "0.25",
    },
    ".cm-foldGutter .cm-gutterElement": {
      padding: "0 4px",
      cursor: "pointer",
      color: "var(--text-muted)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--bg-tertiary)",
      border: "1px solid var(--border-color)",
      color: "var(--text-muted)",
      borderRadius: "3px",
      padding: "0 4px",
      margin: "0 2px",
    },
    // Search panel
    ".cm-panels": {
      backgroundColor: "var(--bg-secondary)",
      color: "var(--text-primary)",
      borderBottom: "1px solid var(--border-color)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--border-color)",
    },
    ".cm-search": {
      fontSize: "12px",
    },
    ".cm-search input, .cm-search button": {
      fontSize: "11px",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--status-pending)",
      opacity: "0.3",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--accent)",
      opacity: "0.4",
    },
    // Diff highlighting (used by both unifiedMergeView and MergeView)
    // VS Code-like diff contrast
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
      backgroundColor: "color-mix(in srgb, var(--status-failed) 30%, transparent)",
      boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--status-failed) 75%, transparent)",
    },
    "&.cm-merge-b .cm-changedLine": {
      backgroundColor: "color-mix(in srgb, var(--status-running) 28%, transparent)",
      boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--status-running) 75%, transparent)",
    },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
      backgroundColor: "color-mix(in srgb, var(--status-failed) 60%, transparent)",
      borderRadius: "2px",
    },
    "&.cm-merge-b .cm-changedText": {
      backgroundColor: "color-mix(in srgb, var(--status-running) 58%, transparent)",
      borderRadius: "2px",
    },
  }, { dark: true });
}
