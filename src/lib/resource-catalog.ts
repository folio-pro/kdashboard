// The navigable resource catalog — one source of truth for which built-in
// resource types the UI exposes, how they are labelled, and how they group in
// the sidebar.
//
// Consumers: the sidebar sections, the command palette's "Navigate" entries,
// and the sidebar count fetcher. Icons live in ./resource-icons so this module
// stays free of Svelte/lucide imports and can be used from plain logic + tests.
//
// The `type` values must exist in the backend registry (electron/k8s/kinds.ts
// RESOURCE_TYPES) — except items flagged `virtual`, which open an app view
// rather than a resource table.

export interface CatalogItem {
  /** Display label. */
  name: string;
  /** resource_type sent to the backend (or the view id when `virtual`). */
  type: string;
  /** PascalCase Kind. Absent only for `virtual` items. */
  kind?: string;
  /** kubectl short name shown right-aligned in the sidebar. */
  short?: string;
  /** True for app views (topology, security, port forwards) — not listable. */
  virtual?: boolean;
  /**
   * True for kinds that live outside any namespace (Node, PersistentVolume,
   * ClusterRole, …). Mirrors `clusterScoped` in electron/k8s/kinds.ts — the
   * backend registry is the source of truth and a test pins the two together.
   * The table hides the namespace picker for these and its empty state says
   * "in this cluster", not "in this namespace".
   */
  clusterScoped?: boolean;
}

export interface CatalogSection {
  name: string;
  key: string;
  /** 3-4 char label for the collapsed rail. */
  items: CatalogItem[];
}

export const RESOURCE_SECTIONS: CatalogSection[] = [
  {
    name: "Workloads",
    key: "workloads",
    items: [
      { name: "Pods", type: "pods", kind: "Pod", short: "po" },
      { name: "Deployments", type: "deployments", kind: "Deployment", short: "deploy" },
      { name: "Replica Sets", type: "replicasets", kind: "ReplicaSet", short: "rs" },
      { name: "Stateful Sets", type: "statefulsets", kind: "StatefulSet", short: "sts" },
      { name: "Daemon Sets", type: "daemonsets", kind: "DaemonSet", short: "ds" },
      { name: "Jobs", type: "jobs", kind: "Job", short: "job" },
      { name: "Cron Jobs", type: "cronjobs", kind: "CronJob", short: "cj" },
    ],
  },
  {
    name: "Network",
    key: "network",
    items: [
      { name: "Services", type: "services", kind: "Service", short: "svc" },
      { name: "Endpoints", type: "endpoints", kind: "Endpoints", short: "ep" },
      { name: "Endpoint Slices", type: "endpointslices", kind: "EndpointSlice", short: "eps" },
      { name: "Ingresses", type: "ingresses", kind: "Ingress", short: "ing" },
      { name: "Ingress Classes", type: "ingressclasses", kind: "IngressClass", short: "ingclass", clusterScoped: true },
      { name: "Port Forwards", type: "portforwards", short: "pf", virtual: true },
    ],
  },
  {
    name: "Configuration",
    key: "configuration",
    items: [
      { name: "Config Maps", type: "configmaps", kind: "ConfigMap", short: "cm" },
      { name: "Secrets", type: "secrets", kind: "Secret", short: "secret" },
    ],
  },
  {
    name: "Scaling",
    key: "scaling",
    items: [
      { name: "HPA", type: "hpa", kind: "HorizontalPodAutoscaler", short: "hpa" },
      { name: "VPA", type: "vpa", kind: "VerticalPodAutoscaler", short: "vpa" },
      { name: "WPA", type: "wpa", kind: "WatermarkPodAutoscaler", short: "wpa" },
    ],
  },
  {
    name: "Storage",
    key: "storage",
    items: [
      { name: "Persistent Volumes", type: "persistentvolumes", kind: "PersistentVolume", short: "pv", clusterScoped: true },
      { name: "Persistent Volume Claims", type: "persistentvolumeclaims", kind: "PersistentVolumeClaim", short: "pvc" },
      { name: "Storage Classes", type: "storageclasses", kind: "StorageClass", short: "sc", clusterScoped: true },
      { name: "CSI Drivers", type: "csidrivers", kind: "CSIDriver", short: "csidriver", clusterScoped: true },
      { name: "Volume Attachments", type: "volumeattachments", kind: "VolumeAttachment", short: "volattach", clusterScoped: true },
    ],
  },
  {
    name: "RBAC",
    key: "rbac",
    items: [
      { name: "Service Accounts", type: "serviceaccounts", kind: "ServiceAccount", short: "sa" },
      { name: "Roles", type: "roles", kind: "Role", short: "role" },
      { name: "Role Bindings", type: "rolebindings", kind: "RoleBinding", short: "rb" },
      { name: "Cluster Roles", type: "clusterroles", kind: "ClusterRole", short: "clusterrole", clusterScoped: true },
      { name: "Cluster Role Bindings", type: "clusterrolebindings", kind: "ClusterRoleBinding", short: "crb", clusterScoped: true },
    ],
  },
  {
    name: "Policy",
    key: "policy",
    items: [
      { name: "Network Policies", type: "networkpolicies", kind: "NetworkPolicy", short: "netpol" },
      { name: "Resource Quotas", type: "resourcequotas", kind: "ResourceQuota", short: "quota" },
      { name: "Limit Ranges", type: "limitranges", kind: "LimitRange", short: "limits" },
      { name: "Pod Disruption Budgets", type: "poddisruptionbudgets", kind: "PodDisruptionBudget", short: "pdb" },
      { name: "Mutating Webhooks", type: "mutatingwebhookconfigurations", kind: "MutatingWebhookConfiguration", short: "mutating", clusterScoped: true },
      { name: "Validating Webhooks", type: "validatingwebhookconfigurations", kind: "ValidatingWebhookConfiguration", short: "validating", clusterScoped: true },
    ],
  },
  {
    name: "Cluster",
    key: "cluster",
    items: [
      { name: "Overview", type: "overview", virtual: true },
      { name: "Problems", type: "problems", virtual: true },
      { name: "Nodes", type: "nodes", kind: "Node", short: "no", clusterScoped: true },
      { name: "Namespaces", type: "namespaces", kind: "Namespace", short: "ns", clusterScoped: true },
      { name: "Events", type: "events", kind: "Event", short: "ev" },
      { name: "Priority Classes", type: "priorityclasses", kind: "PriorityClass", short: "pc", clusterScoped: true },
      { name: "Runtime Classes", type: "runtimeclasses", kind: "RuntimeClass", short: "runtimeclass", clusterScoped: true },
      { name: "Leases", type: "leases", kind: "Lease", short: "lease" },
      { name: "Helm Releases", type: "helm", short: "helm", virtual: true },
      { name: "Topology", type: "topology", virtual: true },
      { name: "Security", type: "security", virtual: true },
      { name: "Cost", type: "cost", virtual: true },
    ],
  },
];

/** Every catalog item, sections flattened, in sidebar order. */
export const RESOURCE_ITEMS: CatalogItem[] = RESOURCE_SECTIONS.flatMap((s) => s.items);

/** Listable resource types (virtual app views excluded), in sidebar order. */
export const LISTABLE_RESOURCE_TYPES: string[] = RESOURCE_ITEMS.filter((i) => !i.virtual).map(
  (i) => i.type,
);

/**
 * resource_type -> the name the sidebar shows. The view header used to
 * capitalize the type instead, which rendered the acronyms as "Hpa"/"Wpa" and
 * the long plurals as "Persistentvolumeclaims"; the catalog already knows what
 * each view is called, so the header and the sidebar now agree.
 */
export const RESOURCE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  RESOURCE_ITEMS.map((i) => [i.type, i.name]),
);

/**
 * How a resource type reads in the view header. Falls back to capitalizing the
 * type for anything outside the catalog (a CRD the user navigated to).
 */
export function resourceTypeLabel(resourceType: string): string {
  return (
    RESOURCE_TYPE_LABELS[resourceType] ??
    resourceType.charAt(0).toUpperCase() + resourceType.slice(1)
  );
}

/** Catalog types that are cluster-scoped (see CatalogItem.clusterScoped). */
export const CLUSTER_SCOPED_TYPES: ReadonlySet<string> = new Set(
  RESOURCE_ITEMS.filter((i) => i.clusterScoped).map((i) => i.type),
);

/**
 * Is this built-in type cluster-scoped? False for anything outside the
 * catalog — a CRD's scope comes from discovery (k8sStore.isClusterScopedCrd).
 */
export function isClusterScopedType(resourceType: string): boolean {
  return CLUSTER_SCOPED_TYPES.has(resourceType);
}

/** PascalCase Kind -> resource_type, for navigating from an object reference. */
export const KIND_TO_RESOURCE_TYPE: Record<string, string> = Object.fromEntries(
  RESOURCE_ITEMS.filter((i) => i.kind).map((i) => [i.kind as string, i.type]),
);
