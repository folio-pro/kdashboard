// RBAC explorer — who can do what.
//
// Commands:
//   - get_rbac_subjects          { namespace? } -> RbacSubject[]   (every subject any binding names)
//   - get_effective_permissions  { kind, name, subjectNamespace?, namespace?, groups? } -> EffectivePermissions
//
// Both read the four RBAC kinds through the typed client (cluster-wide; Roles
// and RoleBindings fall back to the given namespace when the cluster list is
// refused) and hand them to electron/k8s/rbac.ts, which does the resolving.
// The listing is cached per context+namespace for 30 s as a promise, so the
// two commands the view fires together share one round of lists.

import { optStr, type HandlerCtx, type HandlerMap } from '../dispatch';
import { getActiveContextName, getRbacAuthorizationV1Api, onConfigChange } from '../k8s/client';
import { listScoped } from '../k8s/list-scope';
import { collectSubjects, effectivePermissions, type RbacInput, type SubjectKind } from '../k8s/rbac';
import { createTtlCache } from '../util/ttl-cache';

const CACHE_TTL_MS = 30_000;
const cache = createTtlCache<RbacInput>(CACHE_TTL_MS);
onConfigChange(() => cache.clear());

async function fetchRbac(namespace: string | null): Promise<RbacInput> {
  const api = getRbacAuthorizationV1Api();
  const [clusterRoles, clusterRoleBindings, roles, roleBindings] = await Promise.all([
    listScoped(() => api.listClusterRole(), null, null),
    listScoped(() => api.listClusterRoleBinding(), null, null),
    listScoped(() => api.listRoleForAllNamespaces(), (ns) => api.listNamespacedRole({ namespace: ns }), namespace),
    listScoped(() => api.listRoleBindingForAllNamespaces(), (ns) => api.listNamespacedRoleBinding({ namespace: ns }), namespace),
  ]);
  return { clusterRoles: clusterRoles.items, clusterRoleBindings: clusterRoleBindings.items, roles: roles.items, roleBindings: roleBindings.items };
}

function loadRbac(namespace: string | null): Promise<RbacInput> {
  const key = `${getActiveContextName() ?? ''}|${namespace ?? ''}`;
  return cache.get(key, () => fetchRbac(namespace));
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_rbac_subjects', async (args) => {
    const input = await loadRbac(optStr(args, 'namespace') ?? null);
    return collectSubjects(input.clusterRoleBindings, input.roleBindings);
  });

  handlers.set('get_effective_permissions', async (args) => {
    const kind = String(args.kind ?? '') as SubjectKind;
    const name = String(args.name ?? '');
    if (!['User', 'Group', 'ServiceAccount'].includes(kind) || !name) {
      throw new Error('get_effective_permissions: kind (User|Group|ServiceAccount) and name are required');
    }
    const groups = Array.isArray(args.groups) ? args.groups.filter((g): g is string => typeof g === 'string') : [];
    const input = await loadRbac(optStr(args, 'namespace') ?? null);
    return effectivePermissions(input, { kind, name, namespace: optStr(args, 'subjectNamespace') ?? null, groups });
  });
}
