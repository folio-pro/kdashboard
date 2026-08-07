// Read-path coverage against a real cluster: contexts, namespaces,
// list_resources projections, YAML get, events, selectors.
//
// Runs under node:test (not bun) because the backend's TLS bridge to the
// apiserver relies on undici's global dispatcher, which bun's fetch ignores.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Resource, ResourceList } from '../k8s/resource-types';
import { dispatch, enabled, TEST_CONTEXT, TEST_NAMESPACE } from './setup';

const names = (list: ResourceList): (string | null | undefined)[] =>
  list.items.map((r) => r.metadata.name);

describe('integration: connection', { skip: !enabled }, () => {
  test('get_contexts returns the kind cluster context', async () => {
    const contexts = await dispatch<string[]>('get_contexts');
    assert.ok(contexts.includes(TEST_CONTEXT as string));
  });

  test('get_current_context returns a non-empty name', async () => {
    const current = await dispatch<string>('get_current_context');
    assert.equal(typeof current, 'string');
    assert.ok(current.length > 0);
  });

  test('check_connection reaches the apiserver', async () => {
    assert.equal(await dispatch<boolean>('check_connection'), true);
  });

  test('get_namespaces includes the test namespace and default', async () => {
    const namespaces = await dispatch<string[]>('get_namespaces');
    assert.ok(namespaces.includes(TEST_NAMESPACE));
    assert.ok(namespaces.includes('default'));
  });
});

describe('integration: list_resources', { skip: !enabled }, () => {
  test('pods in the test namespace are projected with kind + namespace', { timeout: 30_000 }, async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'pods',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(list.items.length > 0);
    for (const pod of list.items) {
      assert.equal(pod.kind, 'Pod');
      assert.equal(pod.metadata.namespace, TEST_NAMESPACE);
      assert.ok(pod.metadata.uid);
    }
  });

  test('deployments include test-nginx', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'deployments',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(names(list).includes('test-nginx'));
  });

  test('services include test-nginx-svc', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'services',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(names(list).includes('test-nginx-svc'));
  });

  test('configmaps include test-config with its data keys', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'configmaps',
      namespace: TEST_NAMESPACE,
    });
    const cm = list.items.find((r) => r.metadata.name === 'test-config');
    assert.ok(cm);
    assert.ok('key1' in (cm.data as Record<string, string>));
  });

  test('secrets include test-secret typed Opaque', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'secrets',
      namespace: TEST_NAMESPACE,
    });
    const secret = list.items.find((r) => r.metadata.name === 'test-secret');
    assert.ok(secret);
    assert.equal(secret.kind, 'Secret');
    assert.equal(secret.type, 'Opaque');
  });

  test('jobs include test-job', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'jobs',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(names(list).includes('test-job'));
  });

  test('namespaces as a resource type include the test namespace', async () => {
    const list = await dispatch<ResourceList>('list_resources', { resourceType: 'namespaces' });
    assert.ok(names(list).includes(TEST_NAMESPACE));
  });

  test('nodes returns at least one node', async () => {
    const list = await dispatch<ResourceList>('list_resources', { resourceType: 'nodes' });
    assert.ok(list.items.length > 0);
  });

  test('unknown resource type rejects', async () => {
    await assert.rejects(
      dispatch('list_resources', { resourceType: 'flurbles', namespace: TEST_NAMESPACE }),
    );
  });

  test('list_pods_by_selector filters on app=test-nginx', async () => {
    const list = await dispatch<ResourceList>('list_pods_by_selector', {
      namespace: TEST_NAMESPACE,
      selector: 'app=test-nginx',
    });
    assert.ok(list.items.length > 0);
    for (const pod of list.items) {
      assert.equal(pod.metadata.labels?.app, 'test-nginx');
    }
  });
});

describe('integration: get_resource / yaml / events', { skip: !enabled }, () => {
  test('get_resource_yaml for the deployment round-trips as YAML', async () => {
    const yaml = await dispatch<string>('get_resource_yaml', {
      kind: 'Deployment',
      name: 'test-nginx',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(yaml.includes('kind: Deployment'));
    assert.ok(yaml.includes('test-nginx'));
  });

  test('get_resource_yaml for the configmap includes its data', async () => {
    const yaml = await dispatch<string>('get_resource_yaml', {
      kind: 'ConfigMap',
      name: 'test-config',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(yaml.includes('key1'));
    assert.ok(yaml.includes('value1'));
  });

  test('get_resource returns the deployment with metadata', async () => {
    const dep = await dispatch<Resource>('get_resource', {
      kind: 'Deployment',
      name: 'test-nginx',
      namespace: TEST_NAMESPACE,
    });
    assert.equal(dep.metadata.name, 'test-nginx');
    assert.equal(dep.metadata.namespace, TEST_NAMESPACE);
  });

  test('get_resource for a missing resource rejects', async () => {
    await assert.rejects(
      dispatch('get_resource', {
        kind: 'Deployment',
        name: 'does-not-exist',
        namespace: TEST_NAMESPACE,
      }),
    );
  });

  test('get_events returns an array for the namespace', async () => {
    const events = await dispatch<unknown[]>('get_events', { namespace: TEST_NAMESPACE });
    assert.ok(Array.isArray(events));
  });

  test('get_resource_events returns an array for the deployment', async () => {
    const events = await dispatch<unknown[]>('get_resource_events', {
      resourceType: 'deployments',
      name: 'test-nginx',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(Array.isArray(events));
  });
});
