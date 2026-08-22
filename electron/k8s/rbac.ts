// RBAC "can-i" — pure resolution of a subject's effective permissions from
// the Roles, ClusterRoles and their bindings. No API calls: the handler lists
// the four kinds and this module answers. Wire casing: snake_case.

import type {
  V1ClusterRole,
  V1ClusterRoleBinding,
  V1PolicyRule,
  V1Role,
  V1RoleBinding,
  RbacV1Subject as V1Subject,
} from '@kubernetes/client-node';

export type SubjectKind = 'User' | 'Group' | 'ServiceAccount';

export interface RbacSubject {
  kind: SubjectKind;
  name: string;
  /** ServiceAccounts only. */
  namespace: string | null;
  /** How many bindings mention it — for ordering the picker. */
  bindings: number;
}

export interface Grant {
  /** "cluster" for ClusterRoleBindings, else the namespace of the RoleBinding. */
  scope: string;
  binding_kind: 'ClusterRoleBinding' | 'RoleBinding';
  binding: string;
  role_kind: 'ClusterRole' | 'Role';
  role: string;
  /** Matched through which subject entry (a Group grants through membership). */
  via: { kind: SubjectKind; name: string };
  rules: PolicyRule[];
}

export interface PolicyRule {
  api_groups: string[];
  resources: string[];
  verbs: string[];
  resource_names: string[];
  non_resource_urls: string[];
}

export interface PermissionRow {
  /** "" for the core group. */
  api_group: string;
  resource: string;
  verbs: string[];
  /** Namespaces (or "cluster") that grant any of these verbs. */
  scopes: string[];
  /** Restricted to these object names, when every granting rule names some. */
  resource_names: string[] | null;
}

export interface EffectivePermissions {
  subject: { kind: SubjectKind; name: string; namespace: string | null };
  /** Groups the subject is treated as a member of (ServiceAccount implicit groups, plus `groups` passed in). */
  groups: string[];
  grants: Grant[];
  rows: PermissionRow[];
  /** True when a rule grants `*` on `*` — the row list is then a formality. */
  cluster_admin: boolean;
  /** Roles referenced by a binding but not found (deleted role, or not listable). */
  missing_roles: string[];
}

export const ALL_VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection'];

function rule(r: V1PolicyRule): PolicyRule {
  return {
    api_groups: r.apiGroups ?? [],
    resources: r.resources ?? [],
    verbs: r.verbs ?? [],
    resource_names: r.resourceNames ?? [],
    non_resource_urls: r.nonResourceURLs ?? [],
  };
}

/** Every distinct subject named by any binding, most-referenced first. */
export function collectSubjects(crbs: V1ClusterRoleBinding[], rbs: V1RoleBinding[]): RbacSubject[] {
  const map = new Map<string, RbacSubject>();
  const add = (s: V1Subject) => {
    const kind = s.kind as SubjectKind;
    if (kind !== 'User' && kind !== 'Group' && kind !== 'ServiceAccount') return;
    const ns = kind === 'ServiceAccount' ? (s.namespace ?? null) : null;
    const key = `${kind}/${ns ?? ''}/${s.name}`;
    const e = map.get(key) ?? { kind, name: s.name, namespace: ns, bindings: 0 };
    e.bindings += 1;
    map.set(key, e);
  };
  for (const b of crbs) for (const s of b.subjects ?? []) add(s);
  for (const b of rbs) for (const s of b.subjects ?? []) add(s);
  return [...map.values()].sort((a, b) => b.bindings - a.bindings || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** The groups Kubernetes treats a subject as belonging to, before any external IdP groups. */
export function implicitGroups(kind: SubjectKind, name: string, namespace: string | null): string[] {
  if (kind === 'ServiceAccount') {
    return ['system:serviceaccounts', ...(namespace ? [`system:serviceaccounts:${namespace}`] : []), 'system:authenticated'];
  }
  if (kind === 'User') return ['system:authenticated'];
  return [];
}

function subjectMatches(s: V1Subject, kind: SubjectKind, name: string, namespace: string | null, groups: string[]): { kind: SubjectKind; name: string } | null {
  if (s.kind === kind && s.name === name && (kind !== 'ServiceAccount' || (s.namespace ?? null) === namespace)) {
    return { kind, name };
  }
  if (s.kind === 'Group' && groups.includes(s.name)) return { kind: 'Group', name: s.name };
  return null;
}

export interface RbacInput {
  clusterRoles: V1ClusterRole[];
  roles: V1Role[];
  clusterRoleBindings: V1ClusterRoleBinding[];
  roleBindings: V1RoleBinding[];
}

/**
 * Resolve what `kind/name` may do: walk every binding that names it (or a
 * group it belongs to), pull the bound role's rules, and flatten them into
 * resource rows with the verbs and scopes that grant them.
 */
export function effectivePermissions(
  input: RbacInput,
  subject: { kind: SubjectKind; name: string; namespace?: string | null; groups?: string[] },
): EffectivePermissions {
  const ns = subject.namespace ?? null;
  const groups = [...new Set([...implicitGroups(subject.kind, subject.name, ns), ...(subject.groups ?? [])])];
  const clusterRoles = new Map(input.clusterRoles.map((r) => [r.metadata?.name ?? '', r]));
  const roles = new Map(input.roles.map((r) => [`${r.metadata?.namespace ?? ''}/${r.metadata?.name ?? ''}`, r]));
  const grants: Grant[] = [];
  const missing = new Set<string>();

  for (const b of input.clusterRoleBindings) {
    for (const s of b.subjects ?? []) {
      const via = subjectMatches(s, subject.kind, subject.name, ns, groups);
      if (!via) continue;
      const role = clusterRoles.get(b.roleRef.name);
      if (!role) {
        missing.add(`ClusterRole/${b.roleRef.name}`);
        continue;
      }
      grants.push({ scope: 'cluster', binding_kind: 'ClusterRoleBinding', binding: b.metadata?.name ?? '', role_kind: 'ClusterRole', role: b.roleRef.name, via, rules: (role.rules ?? []).map(rule) });
      break;
    }
  }
  for (const b of input.roleBindings) {
    const bns = b.metadata?.namespace ?? '';
    for (const s of b.subjects ?? []) {
      const via = subjectMatches(s, subject.kind, subject.name, ns, groups);
      if (!via) continue;
      let rules: V1PolicyRule[] | undefined;
      let roleKind: Grant['role_kind'];
      if (b.roleRef.kind === 'ClusterRole') {
        roleKind = 'ClusterRole';
        rules = clusterRoles.get(b.roleRef.name)?.rules;
      } else {
        roleKind = 'Role';
        rules = roles.get(`${bns}/${b.roleRef.name}`)?.rules;
      }
      if (!rules) {
        missing.add(`${b.roleRef.kind}/${bns}/${b.roleRef.name}`);
        break;
      }
      grants.push({ scope: bns, binding_kind: 'RoleBinding', binding: b.metadata?.name ?? '', role_kind: roleKind, role: b.roleRef.name, via, rules: rules.map(rule) });
      break;
    }
  }
  grants.sort((a, b) => (a.scope === 'cluster' ? -1 : b.scope === 'cluster' ? 1 : a.scope.localeCompare(b.scope)) || a.role.localeCompare(b.role));

  return {
    subject: { kind: subject.kind, name: subject.name, namespace: ns },
    groups,
    grants,
    rows: flattenRows(grants),
    cluster_admin: grants.some((g) => g.scope === 'cluster' && g.rules.some((r) => r.api_groups.includes('*') && r.resources.includes('*') && r.verbs.includes('*'))),
    missing_roles: [...missing].sort(),
  };
}

/** One row per (apiGroup, resource), verbs and scopes unioned across grants. */
export function flattenRows(grants: Grant[]): PermissionRow[] {
  const map = new Map<string, PermissionRow & { allNamed: boolean }>();
  for (const g of grants) {
    for (const r of g.rules) {
      if (r.resources.length === 0) continue; // non-resource URL rules
      for (const group of r.api_groups.length ? r.api_groups : ['']) {
        for (const resource of r.resources) {
          const key = `${group}|${resource}`;
          let row = map.get(key);
          if (!row) {
            row = { api_group: group, resource, verbs: [], scopes: [], resource_names: null, allNamed: true };
            map.set(key, row);
          }
          for (const v of r.verbs) if (!row.verbs.includes(v)) row.verbs.push(v);
          if (!row.scopes.includes(g.scope)) row.scopes.push(g.scope);
          if (r.resource_names.length === 0) {
            row.allNamed = false;
          } else {
            row.resource_names = [...new Set([...(row.resource_names ?? []), ...r.resource_names])];
          }
        }
      }
    }
  }
  return [...map.values()]
    .map(({ allNamed, ...row }) => ({
      ...row,
      verbs: sortVerbs(row.verbs),
      scopes: row.scopes.sort((a, b) => (a === 'cluster' ? -1 : b === 'cluster' ? 1 : a.localeCompare(b))),
      resource_names: allNamed ? row.resource_names : null,
    }))
    .sort((a, b) => a.api_group.localeCompare(b.api_group) || a.resource.localeCompare(b.resource));
}

function sortVerbs(verbs: string[]): string[] {
  return [...verbs].sort((a, b) => {
    const ia = ALL_VERBS.indexOf(a);
    const ib = ALL_VERBS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

/**
 * Answer "can subject VERB RESOURCE [in NAMESPACE]?" from resolved grants:
 * a cluster grant covers every namespace; a namespace grant only its own.
 * Wildcards on group, resource and verb count. Returns the grants that say yes.
 */
export function canI(
  perms: EffectivePermissions,
  verb: string,
  resource: string,
  apiGroup = '',
  namespace: string | null = null,
): Grant[] {
  return perms.grants.filter((g) => {
    if (g.scope !== 'cluster' && namespace !== null && g.scope !== namespace) return false;
    if (g.scope !== 'cluster' && namespace === null) return false; // cluster-scoped question
    return g.rules.some(
      (r) =>
        (r.api_groups.includes('*') || r.api_groups.includes(apiGroup)) &&
        (r.resources.includes('*') || r.resources.includes(resource)) &&
        (r.verbs.includes('*') || r.verbs.includes(verb)),
    );
  });
}
