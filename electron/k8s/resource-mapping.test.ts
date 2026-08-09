import { test, expect, describe } from 'bun:test';

import { metaFrom, dynamicToResource, presentOrUndefined, listProjectionFor } from './resource-mapping';

describe('metaFrom — Rust serde null contract', () => {
  test('absent fields serialize as null, NOT omitted', () => {
    // The Rust ResourceMetadata struct has no skip_serializing_if, so None ->
    // JSON null. This is the contract the renderer was built against.
    const m = metaFrom(undefined);
    expect(m.name).toBeNull();
    expect(m.namespace).toBeNull();
    expect(m.uid).toBeNull();
    expect(m.resource_version).toBeNull();
    expect(m.labels).toBeNull();
    expect(m.annotations).toBeNull();
    expect(m.creation_timestamp).toBeNull();
    expect(m.owner_references).toBeNull();
    // Every field present in the serialized JSON (none dropped):
    const json = JSON.parse(JSON.stringify(m));
    expect(Object.keys(json).sort()).toEqual(
      [
        'annotations',
        'creation_timestamp',
        'labels',
        'name',
        'namespace',
        'owner_references',
        'resource_version',
        'uid',
      ].sort(),
    );
  });

  test('maps camelCase k8s meta -> snake_case wire fields', () => {
    const m = metaFrom({
      name: 'web',
      namespace: 'prod',
      uid: 'u1',
      resourceVersion: '42',
      creationTimestamp: '2024-01-01T00:00:00Z',
      labels: { app: 'web' },
      annotations: { a: 'b' },
    });
    expect(m).toEqual({
      name: 'web',
      namespace: 'prod',
      uid: 'u1',
      resource_version: '42',
      creation_timestamp: '2024-01-01T00:00:00Z',
      labels: { app: 'web' },
      annotations: { a: 'b' },
      owner_references: null,
    });
  });

  test('owner_references included only when non-empty', () => {
    expect(metaFrom({ ownerReferences: [] }).owner_references).toBeNull();
    const refs = [{ uid: 'o1', kind: 'ReplicaSet', name: 'rs' }];
    expect(metaFrom({ ownerReferences: refs }).owner_references).toEqual(refs);
  });
});

describe('dynamicToResource', () => {
  test('omits spec/status/data/type when absent (serde skip_serializing_if)', () => {
    const r = dynamicToResource({ metadata: { name: 'x', uid: 'u' } }, 'v1', 'Pod');
    expect(r.api_version).toBe('v1');
    expect(r.kind).toBe('Pod');
    expect('spec' in r).toBe(false);
    expect('status' in r).toBe(false);
    expect('data' in r).toBe(false);
    expect('type' in r).toBe(false);
  });

  test('includes spec/status/data/type when present', () => {
    const r = dynamicToResource(
      { metadata: {}, spec: { replicas: 3 }, status: { phase: 'Running' }, data: { k: 'v' }, type: 'Opaque' },
      'apps/v1',
      'Deployment',
    );
    expect(r.spec).toEqual({ replicas: 3 });
    expect(r.status).toEqual({ phase: 'Running' });
    expect(r.data).toEqual({ k: 'v' });
    expect(r.type).toBe('Opaque');
  });

  test('uses the passed apiVersion/kind, not the body fields', () => {
    const r = dynamicToResource({ apiVersion: 'wrong', kind: 'Wrong', metadata: {} }, 'v1', 'Service');
    expect(r.api_version).toBe('v1');
    expect(r.kind).toBe('Service');
  });
});

describe('list projections — synthetic spec fields', () => {
  test('RoleBinding keeps roleRef/subjects under spec (no bespoke projector)', () => {
    const project = listProjectionFor('rolebindings')!;
    const r = project({
      metadata: { name: 'rb', namespace: 'prod' },
      roleRef: { kind: 'Role', name: 'reader' },
      subjects: [{ kind: 'ServiceAccount', name: 'app' }],
    });
    expect(r.kind).toBe('RoleBinding');
    expect(r.api_version).toBe('rbac.authorization.k8s.io/v1');
    expect(r.spec).toEqual({
      roleRef: { kind: 'Role', name: 'reader' },
      subjects: [{ kind: 'ServiceAccount', name: 'app' }],
    });
  });

  test('ServiceAccount lifts its top-level secrets list into spec', () => {
    const project = listProjectionFor('serviceaccounts')!;
    const r = project({
      metadata: { name: 'default', namespace: 'prod' },
      secrets: [{ name: 'default-token-abc' }],
    });
    expect(r.kind).toBe('ServiceAccount');
    expect(r.spec).toEqual({ secrets: [{ name: 'default-token-abc' }] });
  });

  test('absent synthetic fields are simply omitted', () => {
    const project = listProjectionFor('priorityclasses')!;
    const r = project({ metadata: { name: 'high' }, value: 1000 });
    expect(r.spec).toEqual({ value: 1000 });
  });

  test('VPA still projects spec + status verbatim', () => {
    const project = listProjectionFor('vpa')!;
    const r = project({
      metadata: { name: 'web' },
      spec: { targetRef: { kind: 'Deployment', name: 'web' } },
      status: { recommendation: {} },
    });
    expect(r.kind).toBe('VerticalPodAutoscaler');
    expect(r.spec).toEqual({ targetRef: { kind: 'Deployment', name: 'web' } });
    expect(r.status).toEqual({ recommendation: {} });
  });

  test('unknown types have no projection', () => {
    expect(listProjectionFor('widgets')).toBeNull();
  });
});

describe('presentOrUndefined', () => {
  test('drops null and undefined, keeps falsy-but-present values', () => {
    expect(presentOrUndefined(null)).toBeUndefined();
    expect(presentOrUndefined(undefined)).toBeUndefined();
    expect(presentOrUndefined(0)).toBe(0);
    expect(presentOrUndefined('')).toBe('');
    expect(presentOrUndefined(false)).toBe(false);
  });
});
