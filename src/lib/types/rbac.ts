// RBAC explorer wire types — mirror electron/k8s/rbac.ts (snake_case).

export type SubjectKind = "User" | "Group" | "ServiceAccount";

export interface RbacSubject {
  kind: SubjectKind;
  name: string;
  namespace: string | null;
  bindings: number;
}

export interface PolicyRule {
  api_groups: string[];
  resources: string[];
  verbs: string[];
  resource_names: string[];
  non_resource_urls: string[];
}

export interface Grant {
  scope: string;
  binding_kind: "ClusterRoleBinding" | "RoleBinding";
  binding: string;
  role_kind: "ClusterRole" | "Role";
  role: string;
  via: { kind: SubjectKind; name: string };
  rules: PolicyRule[];
}

export interface PermissionRow {
  api_group: string;
  resource: string;
  verbs: string[];
  scopes: string[];
  resource_names: string[] | null;
}

export interface EffectivePermissions {
  subject: { kind: SubjectKind; name: string; namespace: string | null };
  groups: string[];
  grants: Grant[];
  rows: PermissionRow[];
  cluster_admin: boolean;
  missing_roles: string[];
}
