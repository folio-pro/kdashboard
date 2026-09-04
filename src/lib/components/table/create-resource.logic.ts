/**
 * Pure logic behind CreateResourceDialog: starter templates, where each
 * manifest will land, and whether the Apply button may be pressed. Kept free
 * of Svelte so it runs under `bun test`.
 */
import type { ManifestResource, ManifestSummary } from "./manifest-summary";

export const TEMPLATE_KINDS = [
  "Deployment",
  "Service",
  "ConfigMap",
  "Secret",
  "Job",
  "CronJob",
  "Ingress",
  "Namespace",
] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Built-in kinds that live outside any namespace. Mirrors the `clusterScoped`
 * flag in `electron/k8s/kinds.ts`; the renderer cannot import that module, and
 * the list changes about once a year. An unknown kind (a CRD) is assumed
 * namespaced — the apiserver rejects a namespace on a cluster-scoped custom
 * resource with a clear message, whereas silently applying into `default`
 * is the failure mode this dialog exists to prevent.
 */
export const CLUSTER_SCOPED_KINDS: ReadonlySet<string> = new Set([
  "APIService",
  "CSIDriver",
  "CSINode",
  "CertificateSigningRequest",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "IngressClass",
  "MutatingWebhookConfiguration",
  "Namespace",
  "Node",
  "PersistentVolume",
  "PriorityClass",
  "RuntimeClass",
  "StorageClass",
  "ValidatingAdmissionPolicy",
  "ValidatingAdmissionPolicyBinding",
  "ValidatingWebhookConfiguration",
  "VolumeAttachment",
]);

export function isClusterScoped(kind: string): boolean {
  return CLUSTER_SCOPED_KINDS.has(kind);
}

/** `metadata:` block with the namespace line only when there is one to put. */
function metadata(name: string, namespace: string, extra = ""): string {
  const ns = namespace ? `\n  namespace: ${namespace}` : "";
  return `metadata:\n  name: ${name}${ns}${extra}`;
}

/**
 * A minimal manifest that the apiserver accepts as-is, so a template is a
 * working starting point rather than a skeleton of placeholders.
 */
export function manifestTemplate(kind: TemplateKind, namespace: string): string {
  switch (kind) {
    case "Deployment":
      return `apiVersion: apps/v1
kind: Deployment
${metadata("my-app", namespace, "\n  labels:\n    app: my-app")}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
`;
    case "Service":
      return `apiVersion: v1
kind: Service
${metadata("my-service", namespace)}
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 80
`;
    case "ConfigMap":
      return `apiVersion: v1
kind: ConfigMap
${metadata("my-config", namespace)}
data:
  key: value
`;
    case "Secret":
      return `apiVersion: v1
kind: Secret
${metadata("my-secret", namespace)}
type: Opaque
stringData:
  password: change-me
`;
    case "Job":
      return `apiVersion: batch/v1
kind: Job
${metadata("my-job", namespace)}
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo hello"]
`;
    case "CronJob":
      return `apiVersion: batch/v1
kind: CronJob
${metadata("my-cronjob", namespace)}
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:1.36
              command: ["sh", "-c", "date"]
`;
    case "Ingress":
      return `apiVersion: networking.k8s.io/v1
kind: Ingress
${metadata("my-ingress", namespace)}
spec:
  rules:
    - host: example.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
`;
    case "Namespace":
      return `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`;
  }
}

/**
 * Add a manifest to whatever is already in the editor: replaces an empty
 * buffer, otherwise appends as a new YAML document.
 */
export function appendDocument(existing: string, text: string): string {
  if (!existing.trim()) return text;
  return `${existing.trimEnd()}\n---\n${text}`;
}

export interface ApplyTarget {
  resource: ManifestResource;
  /** Namespace the manifest will be applied into; null for cluster-scoped
   *  kinds, or when a namespaced manifest has nowhere to go yet. */
  namespace: string | null;
  clusterScoped: boolean;
  /** True when the namespace came from the dialog rather than the manifest —
   *  the summary points it out, since it is the part the user did not write. */
  inferred: boolean;
  /** Namespaced manifest with no namespace anywhere: blocks Apply. */
  needsNamespace: boolean;
}

/**
 * Decide where each manifest lands. The manifest's own `metadata.namespace`
 * wins; otherwise the table's current namespace; otherwise the one picked in
 * the dialog (offered only when the table shows "All namespaces").
 */
export function resolveTargets(
  resources: ManifestResource[],
  currentNamespace: string,
  chosenNamespace: string,
): ApplyTarget[] {
  const fallback = currentNamespace || chosenNamespace || null;
  return resources.map((resource) => {
    const clusterScoped = isClusterScoped(resource.kind);
    if (clusterScoped) {
      return { resource, namespace: null, clusterScoped, inferred: false, needsNamespace: false };
    }
    if (resource.namespace) {
      return { resource, namespace: resource.namespace, clusterScoped, inferred: false, needsNamespace: false };
    }
    return { resource, namespace: fallback, clusterScoped, inferred: fallback !== null, needsNamespace: fallback === null };
  });
}

/** Whether the dialog has to offer a namespace picker for this draft. */
export function needsNamespacePicker(targets: ApplyTarget[], currentNamespace: string): boolean {
  return !currentNamespace && targets.some((t) => !t.clusterScoped && !t.resource.namespace);
}

export interface ApplyButtonState {
  enabled: boolean;
  label: string;
  /** Why Apply is disabled — shown as the button's title. Null when enabled. */
  reason: string | null;
}

export function applyButtonState(summary: ManifestSummary, targets: ApplyTarget[]): ApplyButtonState {
  const n = targets.length;
  const label = n > 1 ? `Apply ${n} resources` : "Apply to cluster";

  if (summary.errors.length > 0) {
    const count = summary.errors.length;
    return { enabled: false, label, reason: `Fix ${count} YAML ${count === 1 ? "error" : "errors"} first` };
  }
  if (n === 0) {
    return { enabled: false, label, reason: "Write or paste a manifest with a `kind` first" };
  }
  const missing = targets.filter((t) => t.needsNamespace);
  if (missing.length > 0) {
    return { enabled: false, label, reason: "Pick a namespace for the manifests that do not name one" };
  }
  return { enabled: true, label, reason: null };
}

/**
 * Serialize one manifest for `apply_yaml`, writing the resolved namespace
 * into `metadata.namespace` so the backend's own fallback ("default") never
 * kicks in. Edits the parsed document rather than rebuilding it, so comments
 * and key order survive the round trip.
 */
export function serializeForApply(target: ApplyTarget): string {
  const { doc } = target.resource;
  if (target.namespace && !target.resource.namespace) {
    doc.setIn(["metadata", "namespace"], target.namespace);
  }
  return doc.toString();
}

/** Short description for the success toast: "Deployment web, Service web". */
export function describeTargets(targets: ApplyTarget[]): string {
  return targets.map((t) => `${t.resource.kind} ${t.resource.name}`).join(", ");
}
