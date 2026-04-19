export interface ClusterOverview {
  nodes: number;
  namespaces: number;
  pods: number;
  deployments: number;
  services: number;
  statefulsets: number;
  daemonsets: number;
  jobs: number;
}

export interface ClusterSummary {
  current_context: string;
  available_contexts: number;
  resource_counts: Record<string, number>;
  cluster_overview: ClusterOverview;
}

// Topology Types

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  namespace?: string;
  api_version: string;
  status?: string;
  is_ghost: boolean;
  depth: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  edge_type: string;
}

export interface ClusterGroup {
  controller_id: string;
  controller_kind: string;
  controller_name: string;
  pod_count: number;
  pod_ids: string[];
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  root_ids: string[];
  has_cycles: boolean;
  total_resources: number;
  clustered: boolean;
  cluster_groups: ClusterGroup[];
}

// Diagnostics Types

export interface DiagnosticIssue {
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  suggestion: string;
}

export interface DiagnosticResult {
  resource_uid: string;
  resource_kind: string;
  resource_name: string;
  health: "healthy" | "degraded" | "unhealthy";
  issues: DiagnosticIssue[];
  checked_at: string;
}
