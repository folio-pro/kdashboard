/**
 * YAML IntelliSense for Kubernetes resources.
 * Provides autocompletion and linting using CodeMirror extensions.
 */

import {
  type CompletionContext,
  type CompletionResult,
  autocompletion,
  completionKeymap,
} from "@codemirror/autocomplete";
import { type Diagnostic, linter } from "@codemirror/lint";
import { type Extension } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { parseDocument } from "yaml";
import {
  K8S_SCHEMAS,
  KIND_API_VERSIONS,
  resolveSchemaAtPath,
  getFieldInfo,
  type SchemaField,
} from "./k8s-schema";

// ---------------------------------------------------------------------------
// YAML path resolution using the yaml parser for accuracy
// ---------------------------------------------------------------------------

interface YamlContext {
  /** Path of YAML keys leading to cursor position */
  path: string[];
  /** Detected resource kind */
  kind: string | null;
  /** Whether cursor is at a key position (before colon) */
  isKey: boolean;
  /** Current indentation level */
  indent: number;
  /** The key on the current line (if value position) */
  currentLineKey: string | null;
}

function getYamlContext(doc: string, pos: number): YamlContext {
  const lines = doc.split("\n");
  let charCount = 0;
  let currentLineIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    if (charCount + lines[i].length + 1 > pos) {
      currentLineIndex = i;
      break;
    }
    charCount += lines[i].length + 1;
  }

  const currentLine = lines[currentLineIndex] || "";
  const colInLine = pos - charCount;
  const textBeforeCursor = currentLine.substring(0, colInLine);

  const indentMatch = currentLine.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1].length : 0;

  // Determine key vs value position
  const colonIdx = textBeforeCursor.indexOf(":");
  const isKey = colonIdx === -1;

  // Extract key on current line
  let currentLineKey: string | null = null;
  if (!isKey) {
    const km = currentLine.match(/^\s*-?\s*(\w[\w.-]*):/);
    if (km) currentLineKey = km[1];
  }

  // Detect kind from root
  let kind: string | null = null;
  for (const line of lines) {
    const kindMatch = line.match(/^kind:\s*(\S+)/);
    if (kindMatch) {
      kind = kindMatch[1].trim();
      break;
    }
  }

  // Build path by walking up the indentation hierarchy
  const path = buildPath(lines, currentLineIndex, indent);

  return { path, kind, isKey, indent, currentLineKey };
}

/**
 * Build the YAML key path by walking backwards through indentation.
 * Handles array items (- key: val) correctly by finding the parent key.
 */
function buildPath(lines: string[], lineIndex: number, currentIndent: number): string[] {
  const path: string[] = [];
  let searchIndent = currentIndent;

  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indentMatch = line.match(/^(\s*)/);
    const lineIndent = indentMatch ? indentMatch[1].length : 0;

    // Only consider lines at a LOWER indent (parents)
    // For the first iteration (i === lineIndex), skip (it's the current line)
    if (i === lineIndex) continue;

    if (lineIndent < searchIndent) {
      // This line is a parent scope
      const isArrayItem = trimmed.startsWith("- ");

      if (isArrayItem) {
        // Array item: "- key: val" - the key is inside the array item, not a path segment
        // We need to keep searching for the array's parent key (at even lower indent)
        searchIndent = lineIndent;
        continue;
      }

      const keyMatch = trimmed.match(/^(\w[\w.-]*):/);
      if (keyMatch) {
        path.unshift(keyMatch[1]);
        searchIndent = lineIndent;
      }
    }

    // Reached root level
    if (lineIndent === 0 && searchIndent === 0) break;
  }

  return path;
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

function k8sCompletionSource(context: CompletionContext): CompletionResult | null {
  const doc = context.state.doc.toString();
  const pos = context.pos;
  const ctx = getYamlContext(doc, pos);

  const line = context.state.doc.lineAt(pos);
  const textBefore = line.text.substring(0, pos - line.from);

  if (ctx.isKey) {
    return getKeyCompletions(context, ctx, textBefore);
  } else {
    return getValueCompletions(context, ctx, textBefore);
  }
}

function getKeyCompletions(
  context: CompletionContext,
  ctx: YamlContext,
  textBefore: string,
): CompletionResult | null {
  // Match partial word being typed
  const wordMatch = textBefore.match(/(?:^|\s|-\s*)(\w[\w.-]*)$/);
  const from = wordMatch ? context.pos - wordMatch[1].length : context.pos;

  // Only show on explicit trigger (Ctrl+Space) or when typing
  if (!wordMatch && !context.explicit) {
    return null;
  }

  // Root level
  if (ctx.indent === 0) {
    // Kind known → suggest top-level fields from schema
    if (ctx.kind && K8S_SCHEMAS[ctx.kind]) {
      const schema = K8S_SCHEMAS[ctx.kind];
      return {
        from,
        options: Object.entries(schema).map(([key, field]) => ({
          label: key,
          type: field.required ? "keyword" : "property",
          detail: field.type + (field.required ? " *" : ""),
          info: field.desc || undefined,
          boost: field.required ? 2 : 0,
        })),
      };
    }

    // No kind yet → suggest generic top-level fields
    return {
      from,
      options: [
        { label: "apiVersion", type: "keyword", detail: "string", info: "API version", boost: 3 },
        { label: "kind", type: "keyword", detail: "string", info: "Resource kind", boost: 3 },
        { label: "metadata", type: "keyword", detail: "object", info: "Resource metadata", boost: 2 },
        { label: "spec", type: "keyword", detail: "object", info: "Resource specification", boost: 1 },
        { label: "data", type: "keyword", detail: "object", info: "Data (ConfigMap/Secret)" },
        { label: "stringData", type: "keyword", detail: "object", info: "String data (Secret)" },
        { label: "type", type: "keyword", detail: "string", info: "Resource type" },
      ],
    };
  }

  // Nested: resolve schema fields at the current path
  if (ctx.kind && ctx.path.length > 0) {
    const fields = resolveSchemaAtPath(ctx.kind, ctx.path);
    if (fields) {
      const options = Object.entries(fields).map(([key, field]) => ({
        label: key,
        type: field.required ? "keyword" : "property",
        detail: field.type + (field.required ? " *" : ""),
        info: field.desc || undefined,
        boost: field.required ? 2 : 0,
      }));

      if (options.length > 0) {
        return { from, options };
      }
    }

    // Path didn't resolve - try parent paths (common when inside array items)
    for (let trim = 1; trim < ctx.path.length; trim++) {
      const shorterPath = ctx.path.slice(0, ctx.path.length - trim);
      const fields = resolveSchemaAtPath(ctx.kind, shorterPath);
      if (fields) {
        const options = Object.entries(fields).map(([key, field]) => ({
          label: key,
          type: field.required ? "keyword" : "property",
          detail: field.type + (field.required ? " *" : ""),
          info: field.desc || undefined,
          boost: field.required ? 1 : 0,
        }));
        if (options.length > 0) {
          return { from, options };
        }
      }
    }
  }

  // Fallback for explicit trigger: offer common YAML keys
  if (context.explicit) {
    return {
      from,
      options: [
        { label: "name", type: "property", detail: "string" },
        { label: "namespace", type: "property", detail: "string" },
        { label: "labels", type: "property", detail: "object" },
        { label: "annotations", type: "property", detail: "object" },
        { label: "image", type: "property", detail: "string" },
        { label: "ports", type: "property", detail: "array" },
        { label: "env", type: "property", detail: "array" },
        { label: "resources", type: "property", detail: "object" },
        { label: "replicas", type: "property", detail: "number" },
        { label: "selector", type: "property", detail: "object" },
        { label: "template", type: "property", detail: "object" },
        { label: "containers", type: "property", detail: "array" },
        { label: "volumes", type: "property", detail: "array" },
        { label: "volumeMounts", type: "property", detail: "array" },
      ],
    };
  }

  return null;
}

function getValueCompletions(
  context: CompletionContext,
  ctx: YamlContext,
  textBefore: string,
): CompletionResult | null {
  const keyMatch = textBefore.match(/^\s*-?\s*(\w[\w.-]*):\s*(.*)/);
  if (!keyMatch) {
    // Maybe cursor is right after ": " — try matching just the colon
    if (!context.explicit) return null;
    // For explicit trigger on value side with no match, nothing to offer
    return null;
  }

  const key = keyMatch[1];
  const valueText = keyMatch[2];
  const from = context.pos - valueText.length;

  // kind → suggest all known resource kinds
  if (key === "kind" && ctx.path.length === 0) {
    return {
      from,
      options: Object.keys(K8S_SCHEMAS).map((k) => ({
        label: k,
        type: "enum",
        detail: "kind",
      })),
    };
  }

  // apiVersion → suggest versions (filtered by kind if known)
  if (key === "apiVersion" && ctx.path.length === 0) {
    const versions = ctx.kind ? KIND_API_VERSIONS[ctx.kind] : null;
    if (versions) {
      return { from, options: versions.map((v) => ({ label: v, type: "enum" })) };
    }
    return {
      from,
      options: [
        { label: "v1", type: "enum" },
        { label: "apps/v1", type: "enum" },
        { label: "batch/v1", type: "enum" },
        { label: "networking.k8s.io/v1", type: "enum" },
        { label: "autoscaling/v2", type: "enum" },
        { label: "rbac.authorization.k8s.io/v1", type: "enum" },
        { label: "policy/v1", type: "enum" },
      ],
    };
  }

  // Schema-based value completions
  if (ctx.kind) {
    // Try resolving the field at different path levels
    let fieldInfo: SchemaField | null = null;

    // Current path (key is child of current context)
    fieldInfo = getFieldInfo(ctx.kind, ctx.path, key);

    // Try one level up
    if (!fieldInfo && ctx.path.length > 0) {
      fieldInfo = getFieldInfo(ctx.kind, ctx.path.slice(0, -1), key);
    }

    // Try from root for top-level-ish keys
    if (!fieldInfo) {
      fieldInfo = getFieldInfo(ctx.kind, [], key);
    }

    if (fieldInfo?.enum) {
      return {
        from,
        options: fieldInfo.enum.map((v) => ({
          label: v,
          type: "enum",
          detail: fieldInfo!.desc || undefined,
        })),
      };
    }

    if (fieldInfo?.type === "boolean") {
      return {
        from,
        options: [
          { label: "true", type: "enum" },
          { label: "false", type: "enum" },
        ],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// YAML Linter
// ---------------------------------------------------------------------------

function k8sYamlLinter(view: EditorView): Diagnostic[] {
  const doc = view.state.doc.toString();
  const diagnostics: Diagnostic[] = [];

  if (!doc.trim()) return diagnostics;

  const yamlDoc = parseDocument(doc, { prettyErrors: true });

  // Syntax errors
  for (const err of yamlDoc.errors) {
    const [start, end] = err.pos ?? [0, 1];
    diagnostics.push({
      from: clamp(start, 0, doc.length),
      to: clamp(end, 0, doc.length),
      severity: "error",
      message: err.message,
      source: "yaml",
    });
  }

  // Warnings
  for (const warn of yamlDoc.warnings) {
    const [start, end] = warn.pos ?? [0, 1];
    diagnostics.push({
      from: clamp(start, 0, doc.length),
      to: clamp(end, 0, doc.length),
      severity: "warning",
      message: warn.message,
      source: "yaml",
    });
  }

  if (yamlDoc.errors.length > 0) return diagnostics;

  // Schema validation
  const content = yamlDoc.toJSON();
  if (!content || typeof content !== "object") return diagnostics;

  const kind = (content as Record<string, unknown>).kind as string | undefined;
  if (!kind) {
    diagnostics.push({
      from: 0,
      to: clamp(doc.indexOf("\n"), 0, doc.length),
      severity: "info",
      message: "Missing 'kind' field",
      source: "k8s",
    });
    return diagnostics;
  }

  const schema = K8S_SCHEMAS[kind];
  if (!schema) return diagnostics;

  const obj = content as Record<string, unknown>;

  // Check required top-level fields
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && !(key in obj)) {
      diagnostics.push({
        from: 0,
        to: clamp(doc.indexOf("\n"), 0, doc.length),
        severity: "warning",
        message: `Missing required field: '${key}'`,
        source: "k8s",
      });
    }
  }

  // Validate apiVersion
  if (obj.apiVersion && KIND_API_VERSIONS[kind]) {
    if (!KIND_API_VERSIONS[kind].includes(obj.apiVersion as string)) {
      const pos = findLinePos(doc, "apiVersion");
      if (pos) {
        diagnostics.push({
          from: pos.from,
          to: pos.to,
          severity: "warning",
          message: `Unexpected apiVersion '${obj.apiVersion}' for ${kind}. Expected: ${KIND_API_VERSIONS[kind].join(", ")}`,
          source: "k8s",
        });
      }
    }
  }

  // Validate enum values recursively
  validateFields(doc, obj, schema, [], diagnostics, 0);

  return diagnostics;
}

function validateFields(
  doc: string,
  obj: Record<string, unknown>,
  schema: Record<string, SchemaField>,
  path: string[],
  diagnostics: Diagnostic[],
  depth: number,
): void {
  if (depth > 4) return;

  for (const [key, value] of Object.entries(obj)) {
    if (path.length === 0 && (key === "status" || key === "managedFields")) continue;
    if (
      path.includes("metadata") &&
      ["resourceVersion", "uid", "creationTimestamp", "managedFields", "generation", "selfLink"].includes(key)
    )
      continue;

    const field = schema[key];

    if (field?.enum && typeof value === "string" && !field.enum.includes(value)) {
      const pos = findFieldPos(doc, key);
      if (pos) {
        diagnostics.push({
          from: pos.from,
          to: pos.to,
          severity: "warning",
          message: `Invalid value '${value}' for '${key}'. Expected: ${field.enum.join(", ")}`,
          source: "k8s",
        });
      }
    }

    if (field?.type === "object" && field.children && typeof value === "object" && value !== null && !Array.isArray(value)) {
      validateFields(doc, value as Record<string, unknown>, field.children, [...path, key], diagnostics, depth + 1);
    }

    if (field?.type === "array" && Array.isArray(value) && field.items?.type === "object" && field.items.children) {
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          validateFields(doc, item as Record<string, unknown>, field.items.children, [...path, key], diagnostics, depth + 1);
        }
      }
    }
  }
}

function findLinePos(doc: string, key: string): { from: number; to: number } | null {
  const regex = new RegExp(`^${escapeRegex(key)}:`, "m");
  const match = regex.exec(doc);
  if (!match) return null;
  const lineEnd = doc.indexOf("\n", match.index);
  return { from: match.index, to: lineEnd === -1 ? doc.length : lineEnd };
}

function findFieldPos(doc: string, key: string): { from: number; to: number } | null {
  const regex = new RegExp(`^\\s*-?\\s*${escapeRegex(key)}:`, "m");
  const match = regex.exec(doc);
  if (!match) return null;
  const lineEnd = doc.indexOf("\n", match.index);
  return { from: match.index, to: lineEnd === -1 ? doc.length : lineEnd };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

// ---------------------------------------------------------------------------
// Exported extensions
// ---------------------------------------------------------------------------

export function k8sAutocompletion(): Extension {
  return [
    autocompletion({
      override: [k8sCompletionSource],
      activateOnTyping: true,
      maxRenderedOptions: 30,
      icons: true,
      defaultKeymap: true,
    }),
    keymap.of(completionKeymap),
  ];
}

export function k8sLinter(): Extension {
  return linter(k8sYamlLinter, {
    delay: 500,
  });
}

// Test exports
export {
  getYamlContext as _getYamlContext,
  buildPath as _buildPath,
  clamp as _clamp,
  escapeRegex as _escapeRegex,
  findLinePos as _findLinePos,
  findFieldPos as _findFieldPos,
};
