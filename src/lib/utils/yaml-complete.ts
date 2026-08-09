/**
 * Autocompletion for Kubernetes YAML.
 *
 * Suggestions come from three places, in this order of usefulness:
 *
 *   1. the schema for the kind being edited (cluster OpenAPI, or the static
 *      table when the cluster cannot answer);
 *   2. the cluster itself, for fields that name an existing object — the
 *      ServiceAccounts that actually exist beat "this field takes a string";
 *   3. snippets, for the blocks nobody enjoys typing from memory.
 *
 * The result is expressed as plain data (`Suggestion`), not CodeMirror options,
 * so the whole thing is testable without an editor. yaml-intellisense.ts adapts
 * it to the CodeMirror API.
 */

import { COMMON_ANNOTATIONS, COMMON_LABELS, K8S_SCHEMAS, KIND_API_VERSIONS } from "./k8s-schema";
import type { SchemaField } from "./k8s-schema-fields";
import { clusterValuesFor } from "./cluster-completion-source";
import { loadSchemaProvider, type SchemaProvider } from "./schema-provider";
import { contextAtOffset, type PathSegment, type YamlContext } from "./yaml-ast";

export interface Suggestion {
  label: string;
  /** CodeMirror completion type, which selects the icon. */
  type?: string;
  /** Short right-hand annotation: the field's type, or the referenced kind. */
  detail?: string;
  /** Long-form documentation shown in the side panel. */
  info?: string;
  /** Higher sorts first. Required fields and exact context matches are boosted. */
  boost?: number;
  /** CodeMirror snippet template, applied in place of the plain label. */
  snippet?: string;
}

export interface SuggestionResult {
  /** Offset where the replaced text begins. */
  from: number;
  options: Suggestion[];
}

/** Injected so tests need neither a cluster nor an editor. */
export interface CompletionDeps {
  provider: (kind: string | null, apiVersion: string | null) => Promise<SchemaProvider>;
  clusterValues: (
    path: PathSegment[],
    namespace: string,
  ) => Promise<{ values: string[]; detail: string }>;
  /** Namespace to scope cluster lookups to. */
  namespace: string;
}

export const DEFAULT_DEPS: CompletionDeps = {
  provider: loadSchemaProvider,
  clusterValues: clusterValuesFor,
  namespace: "",
};

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/** Whole-resource skeletons, offered on an empty document. */
const RESOURCE_SNIPPETS: Suggestion[] = [
  {
    label: "Deployment",
    type: "class",
    detail: "skeleton",
    info: "A Deployment with one container, a matching selector and a container port.",
    boost: 9,
    snippet: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${name}
  labels:
    app: \${name}
spec:
  replicas: \${1}
  selector:
    matchLabels:
      app: \${name}
  template:
    metadata:
      labels:
        app: \${name}
    spec:
      containers:
        - name: \${name}
          image: \${image}
          ports:
            - containerPort: \${8080}
`,
  },
  {
    label: "Service",
    type: "class",
    detail: "skeleton",
    info: "A ClusterIP Service selecting pods by the app label.",
    boost: 8,
    snippet: `apiVersion: v1
kind: Service
metadata:
  name: \${name}
spec:
  type: ClusterIP
  selector:
    app: \${name}
  ports:
    - name: http
      port: \${80}
      targetPort: \${8080}
      protocol: TCP
`,
  },
  {
    label: "ConfigMap",
    type: "class",
    detail: "skeleton",
    boost: 7,
    snippet: `apiVersion: v1
kind: ConfigMap
metadata:
  name: \${name}
data:
  \${key}: \${value}
`,
  },
  {
    label: "Secret",
    type: "class",
    detail: "skeleton",
    info: "Uses stringData, which the apiserver base64-encodes on write.",
    boost: 6,
    snippet: `apiVersion: v1
kind: Secret
metadata:
  name: \${name}
type: Opaque
stringData:
  \${key}: \${value}
`,
  },
  {
    label: "Pod",
    type: "class",
    detail: "skeleton",
    boost: 5,
    snippet: `apiVersion: v1
kind: Pod
metadata:
  name: \${name}
spec:
  containers:
    - name: \${name}
      image: \${image}
`,
  },
  {
    label: "Ingress",
    type: "class",
    detail: "skeleton",
    boost: 4,
    snippet: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: \${name}
spec:
  ingressClassName: \${nginx}
  rules:
    - host: \${example.com}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: \${name}
                port:
                  number: \${80}
`,
  },
  {
    label: "CronJob",
    type: "class",
    detail: "skeleton",
    boost: 3,
    snippet: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: \${name}
spec:
  schedule: "\${*/5 * * * *}"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: \${name}
              image: \${image}
`,
  },
];

/**
 * Block snippets, keyed by the field they complete. Offered only at a key
 * position whose schema knows the field, so they never appear where they make
 * no sense.
 */
const BLOCK_SNIPPETS: Record<string, string> = {
  containers: `containers:
  - name: \${name}
    image: \${image}
    ports:
      - containerPort: \${8080}
`,
  resources: `resources:
  requests:
    cpu: \${100m}
    memory: \${128Mi}
  limits:
    cpu: \${500m}
    memory: \${256Mi}
`,
  livenessProbe: `livenessProbe:
  httpGet:
    path: \${/healthz}
    port: \${8080}
  initialDelaySeconds: \${10}
  periodSeconds: \${10}
`,
  readinessProbe: `readinessProbe:
  httpGet:
    path: \${/ready}
    port: \${8080}
  initialDelaySeconds: \${5}
  periodSeconds: \${10}
`,
  env: `env:
  - name: \${NAME}
    value: "\${value}"
`,
  volumeMounts: `volumeMounts:
  - name: \${name}
    mountPath: \${/data}
`,
  securityContext: `securityContext:
  runAsNonRoot: true
  runAsUser: \${1000}
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
`,
};

// ---------------------------------------------------------------------------
// Prefix extraction
// ---------------------------------------------------------------------------

/** Characters that can appear in a key or an unquoted value. */
const WORD = /[\w.\-/:@]*$/;

/** Offset where the token under the cursor starts. */
function tokenStart(text: string, pos: number): number {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const match = before.match(WORD);
  return pos - (match ? match[0].length : 0);
}

/** Offset where the value after `key:` starts. */
function valueStart(text: string, pos: number): number {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const match = before.match(/[^\s]*$/);
  return pos - (match ? match[0].length : 0);
}

// ---------------------------------------------------------------------------
// Field suggestions
// ---------------------------------------------------------------------------

/** First sentence of a schema description — the rest is noise in a popup. */
function summarize(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  const trimmed = desc.trim();
  const stop = trimmed.search(/\.\s/);
  const first = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return first.length > 400 ? `${first.slice(0, 397)}...` : first;
}

function fieldSuggestions(
  fields: Record<string, SchemaField>,
  existing: Set<string>,
): Suggestion[] {
  return Object.entries(fields).map(([name, field]) => {
    const snippet = BLOCK_SNIPPETS[name];
    return {
      label: name,
      type: field.required ? "keyword" : "property",
      detail: snippet ? `${field.type} · block` : field.required ? `${field.type} *` : field.type,
      info: summarize(field.desc),
      // Required fields first; fields already present sink, so the list leads
      // with what is still missing.
      boost: (field.required ? 2 : 0) - (existing.has(name) ? 3 : 0),
      ...(snippet ? { snippet } : {}),
    };
  });
}

/** Sibling keys already written at the cursor's indentation. */
function siblingKeys(text: string, pos: number, indent: number): Set<string> {
  const out = new Set<string>();
  const lines = text.split("\n");

  let offset = 0;
  let cursorLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (pos < offset + lines[i].length + 1) {
      cursorLine = i;
      break;
    }
    offset += lines[i].length + 1;
  }

  const scan = (step: number) => {
    for (let i = cursorLine + step; i >= 0 && i < lines.length; i += step) {
      const line = lines[i];
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent) break;
      if (lineIndent > indent) continue;
      const key = line.trim().replace(/^-\s*/, "").split(":")[0]?.trim();
      if (key) out.add(key);
    }
  };
  scan(-1);
  scan(1);
  return out;
}

function rootKeySuggestions(): Suggestion[] {
  return [
    { label: "apiVersion", type: "keyword", detail: "string", boost: 3 },
    { label: "kind", type: "keyword", detail: "string", boost: 3 },
    { label: "metadata", type: "keyword", detail: "object", boost: 2 },
    { label: "spec", type: "keyword", detail: "object", boost: 1 },
  ];
}

// ---------------------------------------------------------------------------
// Key position
// ---------------------------------------------------------------------------

async function keyCompletions(
  text: string,
  pos: number,
  ctx: YamlContext,
  deps: CompletionDeps,
  explicit: boolean,
): Promise<SuggestionResult | null> {
  const from = tokenStart(text, pos);
  const typed = text.slice(from, pos);

  // An empty document is the one place a whole-resource skeleton helps.
  if (!ctx.kind && text.trim() === typed.trim()) {
    return { from, options: [...RESOURCE_SNIPPETS, ...rootKeySuggestions()] };
  }

  if (typed === "" && !explicit) return null;

  // Open maps: the schema types these as string->string, so the useful
  // suggestions are the conventional keys rather than the schema.
  const tail = ctx.path[ctx.path.length - 1];
  if (tail === "labels" || tail === "matchLabels") {
    return { from, options: COMMON_LABELS.map((l) => ({ label: l, type: "property" })) };
  }
  if (tail === "annotations") {
    return { from, options: COMMON_ANNOTATIONS.map((a) => ({ label: a, type: "property" })) };
  }

  if (ctx.path.length === 0 && !ctx.kind) {
    return { from, options: rootKeySuggestions() };
  }

  const provider = await deps.provider(ctx.kind, ctx.apiVersion);
  const fields = provider.fieldsAt(ctx.path);
  if (!fields || Object.keys(fields).length === 0) {
    return explicit ? { from, options: rootKeySuggestions() } : null;
  }

  const existing = siblingKeys(text, pos, ctx.indent);
  return { from, options: fieldSuggestions(fields, existing) };
}

// ---------------------------------------------------------------------------
// Value position
// ---------------------------------------------------------------------------

async function valueCompletions(
  text: string,
  pos: number,
  ctx: YamlContext,
  deps: CompletionDeps,
): Promise<SuggestionResult | null> {
  const key = ctx.currentKey;
  if (!key) return null;

  const from = valueStart(text, pos);
  const valuePath: PathSegment[] = [...ctx.path, key];

  if (key === "kind" && ctx.path.length === 0) {
    return {
      from,
      options: Object.keys(K8S_SCHEMAS).map((k) => ({ label: k, type: "enum", detail: "kind" })),
    };
  }

  if (key === "apiVersion" && ctx.path.length === 0) {
    const versions = ctx.kind ? KIND_API_VERSIONS[ctx.kind] : null;
    const list = versions ?? [
      "v1",
      "apps/v1",
      "batch/v1",
      "networking.k8s.io/v1",
      "autoscaling/v2",
      "rbac.authorization.k8s.io/v1",
      "policy/v1",
    ];
    return { from, options: list.map((v) => ({ label: v, type: "enum" })) };
  }

  const provider = await deps.provider(ctx.kind, ctx.apiVersion);
  const field = provider.fieldAt(valuePath);

  if (field?.enum?.length) {
    return {
      from,
      options: field.enum.map((v) => ({ label: v, type: "enum", info: summarize(field.desc) })),
    };
  }

  if (field?.type === "boolean") {
    return {
      from,
      options: [
        { label: "true", type: "enum" },
        { label: "false", type: "enum" },
      ],
    };
  }

  // Names of objects that already exist beat any generic hint.
  const { values, detail } = await deps.clusterValues(valuePath, deps.namespace);
  if (values.length > 0) {
    return { from, options: values.map((v) => ({ label: v, type: "variable", detail })) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Suggestions for a cursor position, or null when there is nothing worth
 * offering. `explicit` is true when the user pressed the completion key, which
 * loosens the "only suggest once something is typed" rule.
 */
export async function completionsFor(
  text: string,
  pos: number,
  explicit: boolean,
  deps: CompletionDeps = DEFAULT_DEPS,
): Promise<SuggestionResult | null> {
  const ctx = contextAtOffset(text, pos);
  const result = ctx.isKey
    ? await keyCompletions(text, pos, ctx, deps, explicit)
    : await valueCompletions(text, pos, ctx, deps);

  if (!result || result.options.length === 0) return null;
  return result;
}

// Test exports
export {
  tokenStart as _tokenStart,
  valueStart as _valueStart,
  summarize as _summarize,
  siblingKeys as _siblingKeys,
  RESOURCE_SNIPPETS as _RESOURCE_SNIPPETS,
  BLOCK_SNIPPETS as _BLOCK_SNIPPETS,
};
