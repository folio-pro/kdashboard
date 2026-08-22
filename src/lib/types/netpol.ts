// NetworkPolicy overview wire types — mirror electron/k8s/netpol.ts.

export interface PeerSummary {
  any: boolean;
  workloads: string[];
  namespaces: string[];
  cidrs: string[];
  ports: string[];
}

export interface WorkloadPolicyStatus {
  kind: string;
  name: string;
  pod_count: number;
  isolated_ingress: boolean;
  isolated_egress: boolean;
  policies: string[];
  allowed_from: PeerSummary;
  allowed_to: PeerSummary;
}

export interface PolicySummary {
  name: string;
  policy_types: string[];
  selects: string[];
  pod_count: number;
  selects_all: boolean;
  ingress_rules: number;
  egress_rules: number;
}

export interface AllowedFlow {
  from: string;
  to: string;
  ports: string[];
  policy: string;
}

export interface NetworkPolicyOverview {
  namespace: string;
  policy_count: number;
  default_deny_ingress: boolean;
  default_deny_egress: boolean;
  policies: PolicySummary[];
  workloads: WorkloadPolicyStatus[];
  flows: AllowedFlow[];
  fetched_at: string;
}
