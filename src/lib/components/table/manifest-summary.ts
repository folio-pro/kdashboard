export interface ManifestResource {
  /** Stable key for the {#each} block — index-qualified, since a document may
   *  legitimately repeat the same kind/name pair across separators. */
  key: string;
  kind: string;
  name: string;
}

export interface ManifestSummary {
  resources: ManifestResource[];
}

/**
 * Pull the kind/name of each document out of a multi-document YAML string, so
 * the apply dialog can say what is about to hit the cluster.
 *
 * Deliberately a line scanner rather than a real YAML parse: this runs on
 * arbitrary clipboard content that may not be valid YAML at all, and its only
 * job is to label a preview the user is going to read anyway. Unparseable
 * input must degrade to "no resources detected" (which the dialog surfaces as
 * a warning), never to a thrown error that blocks the preview.
 */
export function summarizeManifests(yaml: string): ManifestSummary {
  const resources: ManifestResource[] = [];
  if (!yaml.trim()) return { resources };

  // `---` on its own line separates documents.
  const docs = yaml.split(/^---\s*$/m);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (!doc.trim()) continue;

    // Top-level keys only (column 0): a `kind:` nested under spec.template
    // describes a pod template, not the document's own kind.
    const kind = doc.match(/^kind:[ \t]*["']?([A-Za-z0-9.-]+)["']?[ \t]*$/m)?.[1];
    if (!kind) continue;

    // metadata.name is indented under a top-level `metadata:`; take the first
    // `name:` that follows it.
    const afterMetadata = doc.split(/^metadata:[ \t]*$/m)[1];
    const name =
      afterMetadata?.match(/^[ \t]+name:[ \t]*["']?([^"'\s#]+)["']?/m)?.[1] ?? "(unnamed)";

    resources.push({ key: `${i}-${kind}-${name}`, kind, name });
  }

  return { resources };
}
