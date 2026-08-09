/**
 * CodeMirror bindings for the Kubernetes YAML editor.
 *
 * This module is a thin adapter. The thinking lives elsewhere so it can be
 * tested without an editor instance:
 *
 *   yaml-ast.ts         cursor context and exact source ranges
 *   yaml-complete.ts    what to suggest
 *   yaml-lint.ts        what to complain about
 *   schema-provider.ts  where the schema comes from
 */

import {
  autocompletion,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import { type Extension } from "@codemirror/state";
import { hoverTooltip, keymap, type EditorView } from "@codemirror/view";

import { peekSchemaProvider } from "./schema-provider";
import { contextAtOffset } from "./yaml-ast";
import { completionsFor, DEFAULT_DEPS, type Suggestion } from "./yaml-complete";
import { lintYaml } from "./yaml-lint";

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

function toCompletion(suggestion: Suggestion): Completion {
  const base: Completion = {
    label: suggestion.label,
    type: suggestion.type,
    detail: suggestion.detail,
    info: suggestion.info,
    boost: suggestion.boost,
  };

  // snippetCompletion owns `apply`; everything else carries over so a snippet
  // still shows its icon and documentation.
  return suggestion.snippet ? snippetCompletion(suggestion.snippet, base) : base;
}

function makeCompletionSource(namespace: string) {
  const deps = { ...DEFAULT_DEPS, namespace };

  return async function k8sCompletionSource(
    context: CompletionContext,
  ): Promise<CompletionResult | null> {
    const text = context.state.doc.toString();
    const result = await completionsFor(text, context.pos, context.explicit, deps);
    // The document may have moved on while the schema or cluster lookup was in
    // flight; dropping the stale result avoids a popup for a vanished position.
    if (!result || context.aborted) return null;

    return { from: result.from, options: result.options.map(toCompletion) };
  };
}

/**
 * Autocompletion for Kubernetes YAML.
 * `namespace` scopes cluster-backed value suggestions (ConfigMaps, Secrets…).
 */
export function k8sAutocompletion(namespace = ""): Extension {
  return [
    autocompletion({
      override: [makeCompletionSource(namespace)],
      activateOnTyping: true,
      maxRenderedOptions: 30,
      icons: true,
      defaultKeymap: true,
      closeOnBlur: true,
    }),
    keymap.of(completionKeymap),
  ];
}

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

export function k8sLinter(): Extension {
  return linter((view: EditorView) => lintYaml(view.state.doc.toString()), {
    delay: 400,
  });
}

// ---------------------------------------------------------------------------
// Hover documentation
// ---------------------------------------------------------------------------

/**
 * Field documentation on hover.
 *
 * Reads the schema from cache only — a hover must never wait on the network, so
 * before the schema has loaded no tooltip appears.
 */
export function k8sHoverDocs(): Extension {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const col = pos - line.from;

      // Only keys are documented; hovering a value says nothing useful.
      const colonAt = line.text.indexOf(":");
      if (colonAt !== -1 && col > colonAt) return null;

      const wordStart = line.text.slice(0, col).search(/[\w.\-/]*$/);
      const trailing = line.text.slice(col).match(/^[\w.\-/]*/)?.[0].length ?? 0;
      const wordEnd = col + trailing;
      const word = line.text.slice(wordStart, wordEnd).trim();
      if (!word) return null;

      const ctx = contextAtOffset(view.state.doc.toString(), pos);
      const provider = peekSchemaProvider(ctx.kind, ctx.apiVersion);
      const field = provider.fieldAt([...ctx.path, word]);
      if (!field) return null;

      return {
        pos: line.from + wordStart,
        end: line.from + wordEnd,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-k8s-hover";

          const heading = document.createElement("div");
          heading.className = "cm-k8s-hover-title";
          heading.textContent = `${word}: ${field.type}${field.required ? " (required)" : ""}`;
          dom.appendChild(heading);

          if (field.desc) {
            const body = document.createElement("div");
            body.className = "cm-k8s-hover-body";
            body.textContent = field.desc;
            dom.appendChild(body);
          }

          if (field.enum?.length) {
            const values = document.createElement("div");
            values.className = "cm-k8s-hover-enum";
            values.textContent = `One of: ${field.enum.join(", ")}`;
            dom.appendChild(values);
          }

          return { dom };
        },
      };
    },
    { hoverTime: 400 },
  );
}
