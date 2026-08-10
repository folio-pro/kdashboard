import { test, expect, describe } from 'bun:test';

import { findRootSchema, openApiPathFor, pruneClosure, type OpenApiSchema } from './openapi-schema';

// ---------------------------------------------------------------------------
// openApiPathFor
// ---------------------------------------------------------------------------
describe('openApiPathFor', () => {
  test('maps a core apiVersion to api/<version>', () => {
    expect(openApiPathFor('v1')).toBe('api/v1');
  });

  test('maps a grouped apiVersion to apis/<group>/<version>', () => {
    expect(openApiPathFor('apps/v1')).toBe('apis/apps/v1');
  });

  test('handles a dotted group', () => {
    expect(openApiPathFor('networking.k8s.io/v1')).toBe('apis/networking.k8s.io/v1');
  });

  test('trims surrounding whitespace', () => {
    expect(openApiPathFor('  batch/v1  ')).toBe('apis/batch/v1');
  });

  test('rejects an empty string', () => {
    expect(openApiPathFor('')).toBeNull();
  });

  test('rejects a malformed three-segment version', () => {
    expect(openApiPathFor('a/b/c')).toBeNull();
  });

  // The apiVersion comes from the YAML in the editor, so it is attacker-
  // influenced whenever someone opens a manifest they were sent. The result is
  // interpolated into the apiserver path and into a cache filename that escapes
  // only `/`.
  test.each([
    '..\\..\\evil',
    '../evil',
    'v1?injected=1',
    'v1#frag',
    'v1 v2',
    '-leading',
    'v1%2e%2e',
    'a/b c',
  ])('rejects the unsafe apiVersion %j', (value: string) => {
    expect(openApiPathFor(value)).toBeNull();
  });

  test('still accepts a realistic aggregated group', () => {
    expect(openApiPathFor('metrics.k8s.io/v1beta1')).toBe('apis/metrics.k8s.io/v1beta1');
  });
});

// ---------------------------------------------------------------------------
// findRootSchema
// ---------------------------------------------------------------------------
describe('findRootSchema', () => {
  const schemas: Record<string, OpenApiSchema> = {
    'io.k8s.api.apps.v1.Deployment': {
      type: 'object',
      'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
    },
    'io.k8s.api.apps.v1.StatefulSet': {
      type: 'object',
      'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'StatefulSet' }],
    },
    'io.k8s.api.core.v1.Pod': {
      type: 'object',
      'x-kubernetes-group-version-kind': [{ group: '', version: 'v1', kind: 'Pod' }],
    },
    'io.k8s.api.core.v1.PodSpec': { type: 'object' },
  };

  test('matches on the group-version-kind extension', () => {
    expect(findRootSchema(schemas, 'apps/v1', 'Deployment')).toBe('io.k8s.api.apps.v1.Deployment');
  });

  test('matches a core kind whose group is empty', () => {
    expect(findRootSchema(schemas, 'v1', 'Pod')).toBe('io.k8s.api.core.v1.Pod');
  });

  test('does not confuse two kinds in the same group', () => {
    expect(findRootSchema(schemas, 'apps/v1', 'StatefulSet')).toBe(
      'io.k8s.api.apps.v1.StatefulSet',
    );
  });

  test('rejects a matching kind at the wrong version', () => {
    // A Deployment schema tagged apps/v1 must not answer a request for apps/v2.
    const found = findRootSchema(schemas, 'apps/v2', 'Deployment');
    expect(found).not.toBe('io.k8s.api.apps.v1.Deployment');
  });

  test('falls back to a name suffix when the extension is absent', () => {
    const untagged: Record<string, OpenApiSchema> = {
      'com.example.v1.Widget': { type: 'object' },
    };
    expect(findRootSchema(untagged, 'example.com/v1', 'Widget')).toBe('com.example.v1.Widget');
  });

  test('returns null for an unknown kind', () => {
    expect(findRootSchema(schemas, 'apps/v1', 'Nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pruneClosure
// ---------------------------------------------------------------------------
describe('pruneClosure', () => {
  const ref = (name: string): OpenApiSchema => ({ $ref: `#/components/schemas/${name}` });

  const schemas: Record<string, OpenApiSchema> = {
    Deployment: {
      type: 'object',
      properties: { spec: ref('DeploymentSpec'), metadata: ref('ObjectMeta') },
    },
    DeploymentSpec: {
      type: 'object',
      properties: { template: ref('PodTemplateSpec') },
    },
    PodTemplateSpec: {
      type: 'object',
      properties: { spec: ref('PodSpec') },
    },
    PodSpec: {
      type: 'object',
      properties: { containers: { type: 'array', items: ref('Container') } },
    },
    Container: {
      type: 'object',
      properties: { env: { type: 'array', items: ref('EnvVar') } },
    },
    EnvVar: { type: 'object' },
    ObjectMeta: { type: 'object' },
    // Not reachable from Deployment — must be pruned away.
    Service: { type: 'object', properties: { spec: ref('ServiceSpec') } },
    ServiceSpec: { type: 'object' },
  };

  test('includes the root', () => {
    expect(Object.keys(pruneClosure(schemas, 'Deployment'))).toContain('Deployment');
  });

  test('follows refs transitively through arrays', () => {
    const out = pruneClosure(schemas, 'Deployment');
    expect(Object.keys(out).sort()).toEqual([
      'Container',
      'Deployment',
      'DeploymentSpec',
      'EnvVar',
      'ObjectMeta',
      'PodSpec',
      'PodTemplateSpec',
    ]);
  });

  test('drops unreachable schemas', () => {
    const out = pruneClosure(schemas, 'Deployment');
    expect(out.Service).toBeUndefined();
    expect(out.ServiceSpec).toBeUndefined();
  });

  test('terminates on a self-referential schema', () => {
    // JSONSchemaProps refers to itself; the visited set, not a depth cap, is
    // what stops the walk.
    const cyclic: Record<string, OpenApiSchema> = {
      Props: { type: 'object', properties: { nested: ref('Props') } },
    };
    expect(Object.keys(pruneClosure(cyclic, 'Props'))).toEqual(['Props']);
  });

  test('terminates on a mutual cycle', () => {
    const mutual: Record<string, OpenApiSchema> = {
      A: { properties: { b: ref('B') } },
      B: { properties: { a: ref('A') } },
    };
    expect(Object.keys(pruneClosure(mutual, 'A')).sort()).toEqual(['A', 'B']);
  });

  test('follows refs inside allOf', () => {
    const composed: Record<string, OpenApiSchema> = {
      Root: { allOf: [ref('Base')] },
      Base: { type: 'object' },
    };
    expect(Object.keys(pruneClosure(composed, 'Root')).sort()).toEqual(['Base', 'Root']);
  });

  test('follows refs inside additionalProperties', () => {
    const mapped: Record<string, OpenApiSchema> = {
      Root: { type: 'object', additionalProperties: ref('Value') },
      Value: { type: 'string' },
    };
    expect(Object.keys(pruneClosure(mapped, 'Root')).sort()).toEqual(['Root', 'Value']);
  });

  test('tolerates a dangling ref', () => {
    const dangling: Record<string, OpenApiSchema> = {
      Root: { properties: { gone: ref('Missing') } },
    };
    expect(Object.keys(pruneClosure(dangling, 'Root'))).toEqual(['Root']);
  });

  test('returns empty for an unknown root', () => {
    expect(pruneClosure(schemas, 'Nope')).toEqual({});
  });
});
