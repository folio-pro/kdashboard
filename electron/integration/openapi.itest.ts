// Integration: the cluster's own OpenAPI v3 schemas.
//
// This is the one path in the YAML editor that unit tests cannot cover. They
// exercise the $ref closure, the pruning and the fallback cascade against
// fixtures; what they cannot exercise is the authenticated request to
// /openapi/v3 and the shape the apiserver actually serves. Everything below
// therefore asserts against a live control plane.
//
// The assertions are deliberately about structure rather than exact field sets,
// because those legitimately differ between Kubernetes versions.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { OpenApiSchema, OpenApiSchemaResult } from '../k8s/openapi-schema';
import { dispatch, enabled } from './setup';

/** Follow $ref / single-ref allOf, mirroring the renderer's deref. */
function deref(
  schema: OpenApiSchema | undefined,
  schemas: Record<string, OpenApiSchema>,
  hops = 0,
): OpenApiSchema | undefined {
  if (!schema || hops > 16) return schema;
  const prefix = '#/components/schemas/';
  if (schema.$ref?.startsWith(prefix)) {
    return deref(schemas[schema.$ref.slice(prefix.length)], schemas, hops + 1);
  }
  if (schema.allOf?.length === 1 && !schema.type && !schema.properties) {
    return deref(schema.allOf[0], schemas, hops + 1);
  }
  return schema;
}

/** Walk a property path from the root schema, as the editor does. */
function nodeAt(result: OpenApiSchemaResult, path: string[]): OpenApiSchema | undefined {
  let node = deref(result.schemas[result.root as string], result.schemas);
  for (const key of path) {
    if (!node) return undefined;
    const next = node.properties?.[key];
    if (!next) return undefined;
    node = deref(next, result.schemas);
    // Step through a list into its item shape, which is what a YAML sequence
    // path means.
    if (node?.type === 'array' && node.items) node = deref(node.items, result.schemas);
  }
  return node;
}

describe('integration: OpenAPI schemas', { skip: !enabled }, () => {
  test('a core kind resolves to a schema tagged with its GVK', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'v1',
      kind: 'Pod',
    });

    assert.equal(result.available, true, `expected a schema, got reason: ${result.reason}`);
    assert.ok(result.root, 'a root schema name is required');

    const root = result.schemas[result.root];
    assert.ok(root, 'the root name must be present in the returned closure');
    const gvks = root['x-kubernetes-group-version-kind'] ?? [];
    assert.ok(
      gvks.some((g) => g.kind === 'Pod' && g.version === 'v1' && (g.group ?? '') === ''),
      'the root schema must carry the requested group-version-kind',
    );
  });

  test('a grouped kind resolves through its own API group', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    });

    assert.equal(result.available, true, `expected a schema, got reason: ${result.reason}`);
    assert.match(result.root as string, /Deployment$/);
  });

  test('the closure resolves a deeply nested path the editor actually walks', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    });

    // spec.template.spec.containers[].image — the path autocompletion follows
    // when the cursor sits inside a container.
    const image = nodeAt(result, ['spec', 'template', 'spec', 'containers', 'image']);
    assert.ok(image, 'the container image field must be reachable from the root');
    assert.equal(image.type, 'string');
    assert.ok(image.description, 'the apiserver supplies descriptions used for hover docs');
  });

  test('a nested list field resolves to its item shape', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'v1',
      kind: 'Service',
    });

    const protocol = nodeAt(result, ['spec', 'ports', 'protocol']);
    assert.ok(protocol, 'spec.ports[].protocol must be reachable');
    assert.equal(protocol.type, 'string');
  });

  test('required fields are published, which drives the missing-field warning', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    });

    const spec = nodeAt(result, ['spec']);
    assert.ok(spec, 'spec must be reachable');
    assert.ok(Array.isArray(spec.required), 'DeploymentSpec declares required fields');
    assert.ok(spec.required.includes('selector'), 'selector is required on a DeploymentSpec');
  });

  test('pruning keeps the closure far smaller than the whole group document', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    });

    const count = Object.keys(result.schemas).length;
    assert.ok(count > 5, `expected a real closure, got ${count} schemas`);
    // The apps/v1 document publishes several hundred definitions; a Deployment
    // reaches a fraction of them. This is the property that keeps the IPC
    // payload reasonable.
    assert.ok(count < 400, `closure should be pruned, got ${count} schemas`);
  });

  test('every $ref in the closure resolves inside the closure', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    });

    const prefix = '#/components/schemas/';
    const missing: string[] = [];
    const visit = (schema: OpenApiSchema) => {
      if (schema.$ref?.startsWith(prefix)) {
        const target = schema.$ref.slice(prefix.length);
        if (!(target in result.schemas)) missing.push(target);
      }
      for (const child of Object.values(schema.properties ?? {})) visit(child);
      if (schema.items) visit(schema.items);
      for (const child of schema.allOf ?? []) visit(child);
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        visit(schema.additionalProperties);
      }
    };
    for (const schema of Object.values(result.schemas)) visit(schema);

    assert.deepEqual(missing, [], 'a pruned closure must be self-contained');
  });

  test('an unknown kind degrades instead of throwing', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'apps/v1',
      kind: 'NoSuchKind',
    });

    assert.equal(result.available, false);
    assert.ok(result.reason, 'an unavailable schema must explain itself');
  });

  test('an unsafe apiVersion is rejected before any request is made', async () => {
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: '..\\..\\evil',
      kind: 'Pod',
    });

    assert.equal(result.available, false);
    assert.match(result.reason as string, /unrecognized apiVersion/);
  });

  test('a second request for the same group is served from cache', async () => {
    // Warm, then time a repeat. The cached path does no I/O, so it should be
    // far faster than a fresh multi-MB fetch; the bound is loose to stay stable
    // on slow machines.
    await dispatch('get_openapi_schema', { apiVersion: 'v1', kind: 'ConfigMap' });

    const started = Date.now();
    const result = await dispatch<OpenApiSchemaResult>('get_openapi_schema', {
      apiVersion: 'v1',
      kind: 'Secret',
    });
    const elapsed = Date.now() - started;

    assert.equal(result.available, true);
    assert.ok(elapsed < 1_000, `cached group lookup took ${elapsed}ms`);
  });
});
