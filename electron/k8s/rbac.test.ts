import { describe, expect, test } from 'bun:test';

import { collectSubjects, effectivePermissions, flattenRows, implicitGroups, type RbacInput } from './rbac';

const INPUT: RbacInput = {
  clusterRoles: [
    { metadata: { name: 'cluster-admin' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
    { metadata: { name: 'view' }, rules: [{ apiGroups: ['', 'apps'], resources: ['pods', 'deployments'], verbs: ['get', 'list', 'watch'] }] },
    { metadata: { name: 'secret-reader' }, rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'], resourceNames: ['db-creds'] }] },
  ],
  roles: [
    { metadata: { name: 'deployer', namespace: 'billing' }, rules: [{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['update', 'patch'] }] },
  ],
  clusterRoleBindings: [
    { metadata: { name: 'admins' }, roleRef: { kind: 'ClusterRole', name: 'cluster-admin', apiGroup: '' }, subjects: [{ kind: 'Group', name: 'platform-admins' }, { kind: 'User', name: 'alice' }] },
    { metadata: { name: 'sa-viewers' }, roleRef: { kind: 'ClusterRole', name: 'view', apiGroup: '' }, subjects: [{ kind: 'Group', name: 'system:serviceaccounts:billing' }] },
    { metadata: { name: 'ghost' }, roleRef: { kind: 'ClusterRole', name: 'deleted-role', apiGroup: '' }, subjects: [{ kind: 'User', name: 'bob' }] },
  ],
  roleBindings: [
    { metadata: { name: 'ci-deploys', namespace: 'billing' }, roleRef: { kind: 'Role', name: 'deployer', apiGroup: '' }, subjects: [{ kind: 'ServiceAccount', name: 'ci', namespace: 'billing' }] },
    { metadata: { name: 'ci-secrets', namespace: 'billing' }, roleRef: { kind: 'ClusterRole', name: 'secret-reader', apiGroup: '' }, subjects: [{ kind: 'ServiceAccount', name: 'ci', namespace: 'billing' }] },
    { metadata: { name: 'bob-views', namespace: 'shop' }, roleRef: { kind: 'ClusterRole', name: 'view', apiGroup: '' }, subjects: [{ kind: 'User', name: 'bob' }] },
  ],
};

describe('collectSubjects', () => {
  test('lists every subject once, most-bound first', () => {
    const subjects = collectSubjects(INPUT.clusterRoleBindings, INPUT.roleBindings);
    expect(subjects[0]).toEqual({ kind: 'ServiceAccount', name: 'ci', namespace: 'billing', bindings: 2 });
    expect(subjects.find((s) => s.name === 'bob')?.bindings).toBe(2);
    expect(subjects.map((s) => s.name)).toContain('platform-admins');
  });
});

describe('implicitGroups', () => {
  test('service accounts join their namespace groups; users are merely authenticated', () => {
    expect(implicitGroups('ServiceAccount', 'ci', 'billing')).toEqual(['system:serviceaccounts', 'system:serviceaccounts:billing', 'system:authenticated']);
    expect(implicitGroups('User', 'alice', null)).toEqual(['system:authenticated']);
    expect(implicitGroups('Group', 'g', null)).toEqual([]);
  });
});

describe('effectivePermissions', () => {
  test('a service account gets its direct role bindings plus group-granted cluster roles', () => {
    const p = effectivePermissions(INPUT, { kind: 'ServiceAccount', name: 'ci', namespace: 'billing' });
    expect(p.grants.map((g) => [g.scope, g.role, g.via.kind])).toEqual([
      ['cluster', 'view', 'Group'],
      ['billing', 'deployer', 'ServiceAccount'],
      ['billing', 'secret-reader', 'ServiceAccount'],
    ]);
    expect(p.cluster_admin).toBe(false);
    // `view` grants ['', 'apps'] × ['pods', 'deployments'] (a rule is a cross product), so pick the apps row.
    const deployments = p.rows.find((r) => r.resource === 'deployments' && r.api_group === 'apps');
    expect(deployments).toEqual({ api_group: 'apps', resource: 'deployments', verbs: ['get', 'list', 'watch', 'update', 'patch'], scopes: ['cluster', 'billing'], resource_names: null });
    const secrets = p.rows.find((r) => r.resource === 'secrets');
    expect(secrets?.resource_names).toEqual(['db-creds']);
    expect(secrets?.scopes).toEqual(['billing']);
  });

  test('cluster-admin via group membership is flagged; missing roles are reported', () => {
    const alice = effectivePermissions(INPUT, { kind: 'User', name: 'alice' });
    expect(alice.cluster_admin).toBe(true);
    const bob = effectivePermissions(INPUT, { kind: 'User', name: 'bob' });
    expect(bob.missing_roles).toEqual(['ClusterRole/deleted-role']);
    expect(bob.grants.map((g) => g.scope)).toEqual(['shop']);
    const member = effectivePermissions(INPUT, { kind: 'User', name: 'carol', groups: ['platform-admins'] });
    expect(member.cluster_admin).toBe(true);
    expect(member.grants[0].via).toEqual({ kind: 'Group', name: 'platform-admins' });
  });

  test('flattenRows merges verbs and scopes per resource and drops non-resource rules', () => {
    const rows = flattenRows([
      { scope: 'cluster', binding_kind: 'ClusterRoleBinding', binding: 'b', role_kind: 'ClusterRole', role: 'r', via: { kind: 'User', name: 'u' }, rules: [{ api_groups: [''], resources: ['pods'], verbs: ['list'], resource_names: [], non_resource_urls: [] }, { api_groups: [], resources: [], verbs: ['get'], resource_names: [], non_resource_urls: ['/healthz'] }] },
      { scope: 'a', binding_kind: 'RoleBinding', binding: 'b2', role_kind: 'Role', role: 'r2', via: { kind: 'User', name: 'u' }, rules: [{ api_groups: [''], resources: ['pods'], verbs: ['delete', 'get'], resource_names: [], non_resource_urls: [] }] },
    ]);
    expect(rows).toEqual([{ api_group: '', resource: 'pods', verbs: ['get', 'list', 'delete'], scopes: ['cluster', 'a'], resource_names: null }]);
  });
});
