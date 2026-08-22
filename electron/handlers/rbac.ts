// RBAC explorer — who can do what.
//
// Commands:
//   - get_rbac_subjects          {} -> RbacSubject[]   (every subject any binding names)
//   - get_effective_permissions  { kind, name, namespace?, groups? } -> EffectivePermissions
//
// Both read the four RBAC kinds through the typed client (cluster-wide; Roles
// and RoleBindings fall back to the given namespace when the cluster list is
// refused) and hand them to electron/k8s/rbac.ts, which does the resolving.

import type { V1Role, V1RoleBinding } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getRbacAuthorizationV1Api } from '../k8s/client';
import { collectSubjects, effectivePermissions, type RbacInput, type SubjectKind } from '../k8s/rbac';

const CACHE_TTL_MS = 30_000;
let cache: { at: number; ns: string | null; input: RbacInput } | null = null;

async function loadRbac(namespace: string | null): Promise<RbacInput> {
  if (cache && cache.ns === namespace && Date.now() - cache.at < CACHE_TTL_MS) return cache.input;
  const api = getRbacAuthorizationV1Api();
  const [clusterRoles, clusterRoleBindings] = await Promise.all([
    api.listClusterRole().then((l) => l.items).catch(() => []),
    api.listClusterRoleBinding().then((l) => l.items).catch(() => []),
  ]);
  let roles: V1Role[] = [];
  let roleBindings: V1RoleBinding[] = [];
  try {
    [roles, roleBindings] = await Promise.all([
      api.listRoleForAllNamespaces().then((l) => l.items),
      api.listRoleBindingForAllNamespaces().then((l) => l.items),
    ]);
  } catch {
    if (namespace) {
      [roles, roleBindings] = await Promise.all([
        api.listNamespacedRole({ namespace }).then((l) => l.items).catch(() => []),
        api.listNamespacedRoleBinding({ namespace }).then((l) => l.items).catch(() => []),
      ]);
    }
  }
  const input = { clusterRoles, roles, clusterRoleBindings, roleBindings };
  cache = { at: Date.now(), ns: namespace, input };
  return input;
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_rbac_subjects', async (args) => {
    const ns = typeof args.namespace === 'string' && args.namespace ? args.namespace : null;
    const input = await loadRbac(ns);
    return collectSubjects(input.clusterRoleBindings, input.roleBindings);
  });

  handlers.set('get_effective_permissions', async (args) => {
    const kind = String(args.kind ?? '') as SubjectKind;
    const name = String(args.name ?? '');
    if (!['User', 'Group', 'ServiceAccount'].includes(kind) || !name) {
      throw new Error('get_effective_permissions: kind (User|Group|ServiceAccount) and name are required');
    }
    const subjectNs = typeof args.subjectNamespace === 'string' && args.subjectNamespace ? args.subjectNamespace : null;
    const scopeNs = typeof args.namespace === 'string' && args.namespace ? args.namespace : null;
    const groups = Array.isArray(args.groups) ? args.groups.filter((g): g is string => typeof g === 'string') : [];
    const input = await loadRbac(scopeNs);
    return effectivePermissions(input, { kind, name, namespace: subjectNs, groups });
  });
}
