import { parseAllDocuments, type Document } from "yaml";

export interface ManifestResource {
  /** Stable key for the {#each} block — index-qualified, since a document may
   *  legitimately repeat the same kind/name pair across separators. */
  key: string;
  /** Position of the document in the multi-document stream (0-based). */
  index: number;
  kind: string;
  name: string;
  /** `metadata.namespace` as written, or null when the manifest omits it. */
  namespace: string | null;
  /** The parsed document, kept so the apply path can edit it in place
   *  (inject a namespace) and re-serialize without losing comments. */
  doc: Document.Parsed;
}

export interface ManifestError {
  /** Document index the error belongs to. */
  index: number;
  message: string;
}

export interface ManifestSummary {
  resources: ManifestResource[];
  /** Syntax errors plus documents that parsed but carry no `kind`. Empty and
   *  comment-only documents are ignored rather than reported. */
  errors: ManifestError[];
}

function scalarString(doc: Document.Parsed, path: string[]): string | null {
  const value: unknown = doc.getIn(path, false);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Parse a multi-document YAML string and pull out what the create dialog
 * needs to say what is about to hit the cluster: each document's kind, name
 * and namespace, and every reason a document could not be applied.
 *
 * Runs on every keystroke of the editor, so it must never throw: `yaml`
 * collects syntax errors on the document instead of raising, and non-object
 * documents ("just some text") surface as a missing `kind` rather than an
 * exception.
 */
export function summarizeManifests(yaml: string): ManifestSummary {
  const resources: ManifestResource[] = [];
  const errors: ManifestError[] = [];
  if (!yaml.trim()) return { resources, errors };

  let docs: Document.Parsed[];
  try {
    docs = parseAllDocuments(yaml);
  } catch (err) {
    // parseAllDocuments only throws on internal bugs; keep the dialog alive.
    errors.push({ index: 0, message: err instanceof Error ? err.message : String(err) });
    return { resources, errors };
  }

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (doc.errors.length > 0) {
      errors.push({ index: i, message: doc.errors[0].message.split("\n")[0] });
      continue;
    }
    // Skip blank / comment-only documents — a trailing `---` is not a mistake.
    // (An empty document still has a Scalar node holding null as contents.)
    if (doc.contents === null || doc.contents === undefined || doc.toJS() === null) continue;

    const kind = scalarString(doc, ["kind"]);
    if (!kind) {
      errors.push({ index: i, message: "Document has no `kind` field — this is not a Kubernetes manifest" });
      continue;
    }

    const name = scalarString(doc, ["metadata", "name"]) ?? "(unnamed)";
    const namespace = scalarString(doc, ["metadata", "namespace"]);

    resources.push({ key: `${i}-${kind}-${name}`, index: i, kind, name, namespace, doc });
  }

  return { resources, errors };
}
