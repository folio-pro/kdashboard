import { test, expect, describe } from 'bun:test';

import { apiVersionOf, resolveKind, resolveKindOrThrow, KINDS } from './kinds';

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
});
