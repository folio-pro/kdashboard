export interface OwnerReference {
  api_version: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  block_owner_deletion?: boolean;
}

export interface ResourceMetadata {
  name: string;
  namespace?: string;
  uid: string;
  creation_timestamp: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  owner_references: OwnerReference[];
  resource_version: string;
}

export interface Resource {
  kind: string;
  api_version: string;
  metadata: ResourceMetadata;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  data?: Record<string, unknown>;
  type?: string;
}

export interface ResourceList {
  items: Resource[];
  resource_type: string;
}

export type ResourceType =
  | "pods"
  | "deployments"
  | "replicasets"
  | "statefulsets"
  | "daemonsets"
  | "jobs"
  | "cronjobs"
  | "services"
  | "ingresses"
  | "configmaps"
  | "secrets"
  | "hpa"
  | "vpa"
  | "nodes"
  | "namespaces"
  | "networkpolicies"
  | "persistentvolumes"
  | "persistentvolumeclaims"
  | "storageclasses"
  | "roles"
  | "rolebindings"
  | "clusterroles"
  | "clusterrolebindings"
  | "resourcequotas"
  | "limitranges"
  | "poddisruptionbudgets";

export interface Event {
  name?: string;
  namespace?: string;
  type: string;
  reason: string;
  message: string;
  first_timestamp?: string;
  last_timestamp?: string;
  count?: number;
  source?: Record<string, unknown>;
  involved_object?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CRD types
// ---------------------------------------------------------------------------

export interface CrdInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: "Namespaced" | "Cluster";
  short_names: string[];
}

export interface CrdGroup {
  group: string;
  resources: CrdInfo[];
}

export interface CrdColumn {
  name: string;
  json_path: string;
  column_type: string;
  description: string;
}

export interface CrdResourceList {
  items: Resource[];
  columns: CrdColumn[];
}

export interface StatusCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  last_transition_time?: string;
}

export interface Column {
  key: string;
  label: string;
  sortable: boolean;
  width?: string;
}

export interface ContainerStatus {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state: Record<string, unknown>;
  started?: boolean;
}

export interface PodStatus {
  phase: string;
  podIP?: string;
  hostIP?: string;
  nodeName?: string;
  containerStatuses?: ContainerStatus[];
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

export interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  updatedReplicas?: number;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

export interface SidebarSection {
  name: string;
  resource_types: ResourceType[];
  collapsed: boolean;
}
