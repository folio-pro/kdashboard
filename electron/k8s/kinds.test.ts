import { test, expect, describe } from 'bun:test';

import { apiVersionOf, resolveKind, resolveKindOrThrow, resolveResourceType, KINDS, RESOURCE_TYPES } from './kinds';
import { KIND_TO_RESOURCE_TYPE, LISTABLE_RESOURCE_TYPES } from '../../src/lib/resource-catalog';

describe('apiVersionOf', () => {
  test('core group -> bare version', () => {
    expect(apiVersionOf('', 'v1')).toBe('v1');
  });
  test('grouped -> group/version', () => {
    expect(apiVersionOf('apps', 'v1')).toBe('apps/v1');
    expect(apiVersionOf('rbac.authorization.k8s.io', 'v1')).toBe('rbac.authorization.k8s.io/v1');
  });
});

describe('resolveKind', () => {
  test('resolves a core kind', () => {
    expect(resolveKind('pod')).toEqual({
      group: '',
      version: 'v1',
      plural: 'pods',
      kind: 'Pod',
      clusterScoped: false,
    });
  });

  test('is case-insensitive', () => {
    expect(resolveKind('Pod')).toEqual(resolveKind('pod')!);
    expect(resolveKind('DEPLOYMENT')).toEqual(resolveKind('deployment')!);
  });

  test('resolves short aliases to the same entry', () => {
    expect(resolveKind('hpa')).toEqual(resolveKind('horizontalpodautoscaler')!);
    expect(resolveKind('pvc')).toEqual(resolveKind('persistentvolumeclaim')!);
    expect(resolveKind('pdb')).toEqual(resolveKind('poddisruptionbudget')!);
  });

  test('marks cluster-scoped kinds', () => {
    expect(resolveKind('node')?.clusterScoped).toBe(true);
    expect(resolveKind('namespace')?.clusterScoped).toBe(true);
    expect(resolveKind('clusterrole')?.clusterScoped).toBe(true);
    expect(resolveKind('persistentvolume')?.clusterScoped).toBe(true);
    expect(resolveKind('pod')?.clusterScoped).toBe(false);
  });

  test('returns undefined for unknown kinds', () => {
    expect(resolveKind('widget')).toBeUndefined();
    expect(resolveKind('')).toBeUndefined();
  });
});

describe('resolveKindOrThrow', () => {
  test('returns the entry for a known kind', () => {
    expect(resolveKindOrThrow('deployment').kind).toBe('Deployment');
  });

  test('throws the canonical message for unknown kinds', () => {
    expect(() => resolveKindOrThrow('widget')).toThrow('Unsupported kind for YAML fetch: widget');
  });
});

describe('KINDS registry integrity', () => {
  test('every entry plural is lowercase and kind is PascalCase', () => {
    for (const [alias, entry] of Object.entries(KINDS)) {
      expect(alias).toBe(alias.toLowerCase());
      expect(entry.plural).toBe(entry.plural.toLowerCase());
      expect(entry.kind[0]).toBe(entry.kind[0]!.toUpperCase());
    }
  });

  test('every resource type is reachable by its singular kind', () => {
    for (const entry of Object.values(RESOURCE_TYPES)) {
      expect(resolveKind(entry.kind)).toMatchObject({ plural: entry.plural, group: entry.group });
    }
  });

  test('RESOURCE_TYPES keys match their own `type` field', () => {
    for (const [key, entry] of Object.entries(RESOURCE_TYPES)) {
      expect(entry.type).toBe(key);
    }
  });
});

describe('resolveResourceType', () => {
  test('resolves the kinds the sidebar gained', () => {
    expect(resolveResourceType('serviceaccounts')).toMatchObject({
      group: '',
      version: 'v1',
      kind: 'ServiceAccount',
      clusterScoped: false,
    });
    expect(resolveResourceType('endpointslices')).toMatchObject({
      group: 'discovery.k8s.io',
      kind: 'EndpointSlice',
    });
    expect(resolveResourceType('priorityclasses')).toMatchObject({
      group: 'scheduling.k8s.io',
      kind: 'PriorityClass',
      clusterScoped: true,
    });
    expect(resolveResourceType('validatingwebhookconfigurations')).toMatchObject({
      group: 'admissionregistration.k8s.io',
      clusterScoped: true,
    });
  });

  test('returns undefined for a virtual view id', () => {
    expect(resolveResourceType('topology')).toBeUndefined();
    expect(resolveResourceType('portforwards')).toBeUndefined();
  });
});

describe('catalog <-> registry', () => {
  // The sidebar/palette catalog drives what the UI can navigate to; every one
  // of those types must be listable by the backend or the view 404s.
  test('every listable catalog type exists in the registry', () => {
    for (const type of LISTABLE_RESOURCE_TYPES) {
      expect(resolveResourceType(type)).toBeDefined();
    }
  });

  // The catalog repeats each Kind so the renderer can navigate from an owner
  // reference without a round trip. A typo there would silently break that
  // navigation, so pin the two tables to each other.
  test('catalog Kinds match the registry Kinds', () => {
    for (const [kind, type] of Object.entries(KIND_TO_RESOURCE_TYPE)) {
      expect(resolveResourceType(type)?.kind).toBe(kind);
    }
  });

  test('every listable catalog entry declares its Kind', () => {
    const withKind = new Set(Object.values(KIND_TO_RESOURCE_TYPE));
    for (const type of LISTABLE_RESOURCE_TYPES) {
      expect(withKind.has(type)).toBe(true);
    }
  });
});
