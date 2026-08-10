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

    // -----------------------------------------------------------------------
    // Diagnostics
    //
    // Squiggles are drawn as a repeating gradient rather than
    // text-decoration: wavy, which renders inconsistently across platforms and
    // ignores the decoration colour on some of them.
    // -----------------------------------------------------------------------
    ".cm-lintRange": {
      backgroundImage: "none",
      paddingBottom: "2px",
      backgroundRepeat: "repeat-x",
      backgroundPosition: "left bottom",
      backgroundSize: "6px 2px",
    },
    ".cm-lintRange-error": {
      backgroundImage:
        "repeating-linear-gradient(135deg, var(--status-failed) 0 2px, transparent 2px 4px)",
    },
    ".cm-lintRange-warning": {
      backgroundImage:
        "repeating-linear-gradient(135deg, var(--status-warning) 0 2px, transparent 2px 4px)",
    },
    ".cm-lintRange-info": {
      backgroundImage:
        "repeating-linear-gradient(135deg, var(--text-muted) 0 2px, transparent 2px 4px)",
    },
    ".cm-tooltip-lint": {
      backgroundColor: "var(--bg-secondary)",
      border: "1px solid var(--border-color)",
      borderRadius: "4px",
      boxShadow: "0 4px 16px rgb(0 0 0 / 0.4)",
      maxWidth: "480px",
    },
    ".cm-diagnostic": {
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
      fontSize: "11px",
      lineHeight: "1.5",
      padding: "6px 10px",
      borderLeft: "3px solid transparent",
      color: "var(--text-primary)",
      whiteSpace: "pre-wrap",
    },
    ".cm-diagnostic-error": { borderLeftColor: "var(--status-failed)" },
    ".cm-diagnostic-warning": { borderLeftColor: "var(--status-warning)" },
    ".cm-diagnostic-info": { borderLeftColor: "var(--text-muted)" },
    ".cm-diagnosticSource": {
      color: "var(--text-muted)",
      fontSize: "10px",
      opacity: "0.8",
    },
    ".cm-panel.cm-panel-lint": {
      backgroundColor: "var(--bg-secondary)",
      borderTop: "1px solid var(--border-color)",
    },
    ".cm-panel.cm-panel-lint ul": {
      maxHeight: "160px",
      fontSize: "11px",
    },
    ".cm-panel.cm-panel-lint ul [aria-selected]": {
      backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
      color: "var(--text-primary)",
    },
    ".cm-panel.cm-panel-lint button[name=close]": {
      color: "var(--text-muted)",
    },
    ".cm-gutter-lint": { width: "14px" },
    ".cm-gutter-lint .cm-gutterElement": { padding: "0 2px" },

    // -----------------------------------------------------------------------
    // Autocompletion
    // -----------------------------------------------------------------------
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "var(--bg-secondary)",
      border: "1px solid var(--border-color)",
      borderRadius: "4px",
      boxShadow: "0 8px 24px rgb(0 0 0 / 0.45)",
      overflow: "hidden",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
      fontSize: "11.5px",
      maxHeight: "260px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "3px 8px",
      lineHeight: "1.6",
      color: "var(--text-secondary)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "color-mix(in srgb, var(--accent) 26%, transparent)",
      color: "var(--text-primary)",
    },
    ".cm-completionLabel": { color: "inherit" },
    ".cm-completionMatchedText": {
      color: "var(--accent)",
      textDecoration: "none",
      fontWeight: "600",
    },
    ".cm-completionDetail": {
      color: "var(--text-muted)",
      fontStyle: "normal",
      fontSize: "10px",
      marginLeft: "8px",
    },
    ".cm-completionIcon": {
      opacity: "0.75",
      marginRight: "6px",
      width: "1em",
    },
    ".cm-completionIcon-keyword": { color: "var(--status-warning)" },
    ".cm-completionIcon-property": { color: "var(--accent)" },
    ".cm-completionIcon-enum": { color: "var(--status-succeeded)" },
    ".cm-completionIcon-variable": { color: "var(--status-running)" },
    ".cm-completionIcon-class": { color: "var(--status-pending)" },
    ".cm-completionInfo": {
      backgroundColor: "var(--bg-tertiary)",
      border: "1px solid var(--border-color)",
      borderRadius: "4px",
      color: "var(--text-secondary)",
      fontSize: "11px",
      lineHeight: "1.5",
      maxWidth: "320px",
      padding: "8px 10px",
    },

    // -----------------------------------------------------------------------
    // Hover documentation
    // -----------------------------------------------------------------------
    ".cm-k8s-hover": {
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
      fontSize: "11px",
      lineHeight: "1.55",
      maxWidth: "360px",
      padding: "8px 10px",
      backgroundColor: "var(--bg-secondary)",
      color: "var(--text-secondary)",
    },
    ".cm-k8s-hover-title": {
      color: "var(--accent)",
      fontWeight: "600",
      marginBottom: "4px",
    },
    ".cm-k8s-hover-body": { color: "var(--text-secondary)" },
    ".cm-k8s-hover-enum": {
      color: "var(--text-muted)",
      marginTop: "6px",
      fontSize: "10px",
    },

    // -----------------------------------------------------------------------
    // Kubernetes-aware decorations (see yaml-decorations.ts)
    // -----------------------------------------------------------------------
    ".cm-k8s-root-key": {
      fontWeight: "700",
      color: "var(--accent)",
    },
    ".cm-k8s-doc-separator": {
      color: "var(--text-muted)",
      fontWeight: "700",
      letterSpacing: "1px",
    },
    ".cm-k8s-image-tag": {
      color: "var(--status-pending)",
      fontWeight: "600",
    },
    // Base64 payloads are data, not code: keep them legible but out of the way.
    ".cm-k8s-opaque": {
      color: "var(--text-muted)",
      opacity: "0.55",
    },
    ".cm-k8s-anchor": {
      color: "var(--status-warning)",
      fontWeight: "600",
    },
    ".cm-k8s-indent": {
      backgroundImage:
        "repeating-linear-gradient(to right, color-mix(in srgb, var(--border-color) 80%, transparent) 0 1px, transparent 1px 2ch)",
      backgroundSize: "calc(var(--k8s-indent-depth, 0) * 2ch) 100%",
      backgroundRepeat: "no-repeat",
    },

    // -----------------------------------------------------------------------
    // Structural cues
    // -----------------------------------------------------------------------
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
      outline: "1px solid color-mix(in srgb, var(--accent) 60%, transparent)",
    },
    ".cm-nonmatchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--status-failed) 30%, transparent)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "color-mix(in srgb, var(--status-pending) 25%, transparent)",
      borderRadius: "2px",
    },
  }, { dark: true });
}
