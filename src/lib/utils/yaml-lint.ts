/**
 * Diagnostics for Kubernetes YAML.
 *
 * Every diagnostic is anchored through the parsed CST (see yaml-ast.ts), so it
 * underlines the value the user actually got wrong. The previous implementation
 * located positions with `regex.exec(doc)`, which returns the first occurrence
 * of a key anywhere in the file — with three `protocol:` entries under
 * `spec.ports`, an invalid third one was reported on the first.
 *
 * Schema checks are gated on `provider.authoritative`. Only the cluster's own
 * OpenAPI document lists every valid field, so "unknown field" is reported only
 * when that is the source; against the 12-kind static table it would fire on
 * almost every real manifest.
 */

import { type Diagnostic } from "@codemirror/lint";
import { isMap, isScalar, type Document } from "yaml";

import { KIND_API_VERSIONS } from "./k8s-schema";
import type { SchemaField } from "./k8s-schema-fields";
import { peekSchemaProvider, type SchemaProvider } from "./schema-provider";
import {
  documentsOf,
  plainValue,
  rangeOfEntry,
  rangeOfPath,
  walkPaths,
  type PathSegment,
  type SourceRange,
} from "./yaml-ast";

/** Resolves the schema for a kind. Injected so tests need no IPC. */
export type ProviderLookup = (kind: string | null, apiVersion: string | null) => SchemaProvider;

/**
 * Fields the apiserver owns and returns on every GET. They are not user input,
 * so validating them only produces noise the user cannot act on.
 */
const SERVER_OWNED_METADATA = new Set([
  "creationTimestamp",
  "generation",
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid",
]);

/** RFC 1123 subdomain, the format `metadata.name` takes for most kinds. */
const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const MAX_NAME_LENGTH = 253;

/**
 * Kubernetes resource quantity: a decimal number with an optional binary
 * (Ki, Mi, Gi…) or decimal (n, u, m, k, M, G…) suffix, or scientific notation.
 */
const QUANTITY = /^[+-]?(\d+(\.\d*)?|\.\d+)(([EPTGMk]i?)|[numkKMGTPE]|([eE][+-]?\d+))?$/;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

/** Build a diagnostic, clamping the range into the document. */
function at(
  range: SourceRange | null,
  fallback: SourceRange,
  severity: Diagnostic["severity"],
  message: string,
  source: string,
  docLength: number,
): Diagnostic {
  const r = range ?? fallback;
  return {
    from: clamp(r.from, 0, docLength),
    to: clamp(Math.max(r.to, r.from + 1), 0, docLength),
    severity,
    message,
    source,
  };
}

/** First line of a document, used when a diagnostic has no better anchor. */
function documentAnchor(doc: Document.Parsed, text: string): SourceRange {
  const start = doc.contents?.range?.[0] ?? 0;
  const newline = text.indexOf("\n", start);
  return { from: start, to: newline === -1 ? text.length : newline };
}

// ---------------------------------------------------------------------------
// Value-level checks
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (value === null) return "null";
  switch (typeof value) {
    case "object":
      return "a mapping";
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    default:
      return typeof value;
  }
}

/**
 * Report a value that contradicts its declared type.
 *
 * Deliberately narrow. Kubernetes types several fields as IntOrString
 * (`targetPort`, `maxSurge`), which surfaces as `any`, and anything typed `any`
 * is skipped — a stricter check here produces false positives on valid YAML,
 * which is worse than missing a real one.
 */
function typeMismatch(field: SchemaField, value: unknown): string | null {
  if (field.type === "any") return null;
  if (value === null || value === undefined) return null;

  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") return `Expected a boolean, got ${describe(value)}`;
      return null;
    case "number":
      if (typeof value === "number") return null;
      if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
        return `Expected a number, got the string '${value}' — remove the quotes`;
      }
      return `Expected a number, got ${describe(value)}`;
    case "array":
      if (!Array.isArray(value)) return `Expected a list, got ${describe(value)}`;
      return null;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) {
        return `Expected a mapping, got ${describe(value)}`;
      }
      return null;
    default:
      return null;
  }
}

/** True when a path sits inside a `resources.limits`/`requests` block. */
function isQuantityPath(path: PathSegment[]): boolean {
  if (path.length < 3) return false;
  const parent = path[path.length - 2];
  const grandparent = path[path.length - 3];
  return (parent === "limits" || parent === "requests") && grandparent === "resources";
}

/** True when a path is under `status`, or is a metadata field the server owns. */
function isServerOwned(path: PathSegment[]): boolean {
  if (path[0] === "status") return true;
  if (path.length === 2 && path[0] === "metadata" && typeof path[1] === "string") {
    return SERVER_OWNED_METADATA.has(path[1]);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-document validation
// ---------------------------------------------------------------------------

type Push = (
  range: SourceRange | null,
  severity: Diagnostic["severity"],
  message: string,
  source: string,
) => void;

function validateName(doc: Document.Parsed, content: Record<string, unknown>, push: Push): void {
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const name = (metadata as Record<string, unknown>).name;
  if (typeof name !== "string" || name === "") return;

  const range = rangeOfPath(doc, ["metadata", "name"]);
  if (name.length > MAX_NAME_LENGTH) {
    push(range, "error", `Name exceeds ${MAX_NAME_LENGTH} characters`, "k8s");
    return;
  }
  if (!DNS_1123_SUBDOMAIN.test(name)) {
    push(
      range,
      "error",
      `'${name}' is not a valid name: use lowercase letters, digits, '-' and '.', starting and ending with an alphanumeric character`,
      "k8s",
    );
  }
}

function validateRequired(
  provider: SchemaProvider,
  content: Record<string, unknown>,
  push: Push,
): void {
  const topLevel = provider.fieldsAt([]);
  if (!topLevel) return;

  for (const [key, field] of Object.entries(topLevel)) {
    // `status` is required by some schemas but written by the controller.
    if (!field.required || key === "status") continue;
    if (!(key in content)) {
      push(null, "warning", `Missing required field: '${key}'`, "k8s");
    }
  }
}

function validateFields(
  doc: Document.Parsed,
  provider: SchemaProvider,
  out: Diagnostic[],
  text: string,
  anchor: SourceRange,
): void {
  walkPaths(doc.contents, (path, node) => {
    if (isServerOwned(path)) return;

    const key = path[path.length - 1];
    const field = provider.fieldAt(path);

    if (!field) {
      // Only a complete schema can tell "unknown" from "not modelled".
      if (provider.authoritative && typeof key === "string") {
        const parentFields = provider.fieldsAt(path.slice(0, -1));
        if (parentFields && !(key in parentFields)) {
          out.push(
            at(
              rangeOfPath(doc, path, "key"),
              anchor,
              "warning",
              `Unknown field '${key}' for ${provider.kind}`,
              "k8s",
              text.length,
            ),
          );
        }
      }
      return;
    }

    if (!isScalar(node)) {
      const mismatch = typeMismatch(field, plainValue(node));
      if (mismatch) {
        out.push(at(rangeOfEntry(doc, path), anchor, "warning", mismatch, "k8s", text.length));
      }
      return;
    }

    const value = node.value;

    if (field.enum?.length && typeof value === "string" && !field.enum.includes(value)) {
      out.push(
        at(
          rangeOfPath(doc, path),
          anchor,
          "warning",
          `Invalid value '${value}' for '${String(key)}'. Expected: ${field.enum.join(", ")}`,
          "k8s",
          text.length,
        ),
      );
      return;
    }

    const mismatch = typeMismatch(field, value);
    if (mismatch) {
      out.push(at(rangeOfPath(doc, path), anchor, "warning", mismatch, "k8s", text.length));
      return;
    }

    if (isQuantityPath(path) && typeof value === "string" && !QUANTITY.test(value.trim())) {
      out.push(
        at(
          rangeOfPath(doc, path),
          anchor,
          "warning",
          `'${value}' is not a valid quantity. Use forms like 100m, 1, 512Mi or 2Gi`,
          "k8s",
          text.length,
        ),
      );
      return;
    }

    if (key === "image" && typeof value === "string" && value !== "") {
      const tagged = /:[^/]+$/.test(value) || value.includes("@sha256:");
      if (!tagged) {
        out.push(
          at(
            rangeOfPath(doc, path),
            anchor,
            "info",
            `Image '${value}' has no tag, so it resolves to :latest and is not reproducible`,
            "k8s",
            text.length,
          ),
        );
      }
    }
  });
}

function validateDocument(
  doc: Document.Parsed,
  text: string,
  lookup: ProviderLookup,
  out: Diagnostic[],
): void {
  const anchor = documentAnchor(doc, text);
  const push: Push = (range, severity, message, source) =>
    out.push(at(range, anchor, severity, message, source, text.length));

  const root = doc.contents;
  if (!isMap(root)) return;

  const content = doc.toJSON() as Record<string, unknown> | null;
  if (!content || typeof content !== "object") return;

  const kind = typeof content.kind === "string" ? content.kind : null;
  const apiVersion = typeof content.apiVersion === "string" ? content.apiVersion : null;

  if (!kind) {
    push(null, "info", "Missing 'kind' field", "k8s");
    return;
  }
  if (!apiVersion) {
    push(null, "warning", "Missing 'apiVersion' field", "k8s");
  }

  // apiVersion consistency is checked against the local table rather than the
  // schema, because the schema is fetched *using* the apiVersion — a wrong one
  // yields no schema at all rather than a mismatch we could report.
  const known = KIND_API_VERSIONS[kind];
  if (apiVersion && known && !known.includes(apiVersion)) {
    push(
      rangeOfPath(doc, ["apiVersion"]),
      "warning",
      `Unexpected apiVersion '${apiVersion}' for ${kind}. Expected: ${known.join(", ")}`,
      "k8s",
    );
  }

  validateName(doc, content, push);

  const provider = lookup(kind, apiVersion);
  if (provider.source === "none") return;

  validateRequired(provider, content, push);
  validateFields(doc, provider, out, text, anchor);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Diagnostics for a YAML buffer. Pure and synchronous — the schema provider is
 * consulted from cache, never awaited, so typing never blocks on the network.
 */
export function lintYaml(text: string, lookup: ProviderLookup = peekSchemaProvider): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (text.trim() === "") return out;

  for (const doc of documentsOf(text)) {
    for (const err of doc.errors) {
      const [start, end] = err.pos ?? [0, 1];
      out.push({
        from: clamp(start, 0, text.length),
        to: clamp(Math.max(end, start + 1), 0, text.length),
        severity: "error",
        message: err.message,
        source: "yaml",
      });
    }

    for (const warn of doc.warnings) {
      const [start, end] = warn.pos ?? [0, 1];
      out.push({
        from: clamp(start, 0, text.length),
        to: clamp(Math.max(end, start + 1), 0, text.length),
        severity: "warning",
        message: warn.message,
        source: "yaml",
      });
    }

    // Schema checks read a tree the parser could not fully build; skip them and
    // let the user fix the syntax first.
    if (doc.errors.length > 0) continue;

    validateDocument(doc, text, lookup, out);
  }

  return out.sort((a, b) => a.from - b.from);
}

// Test exports
export {
  typeMismatch as _typeMismatch,
  isQuantityPath as _isQuantityPath,
  isServerOwned as _isServerOwned,
  QUANTITY as _QUANTITY,
  DNS_1123_SUBDOMAIN as _DNS_1123_SUBDOMAIN,
};
