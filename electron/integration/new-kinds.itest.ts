// Integration: the resource types added on top of the original registry.
//
// Every one of these goes through the same list/watch/projection path, so the
// point is to prove the API coordinates resolve and the projection carries the
// fields the tables read (which is exactly what a wrong group/version or a
// missing `synth` entry breaks).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Resource, ResourceList } from '../k8s/resource-types';
import { dispatch, enabled, TEST_NAMESPACE } from './setup';

function byName(list: ResourceList, name: string): Resource | undefined {
  return list.items.find((i) => i.metadata.name === name);
}

function spec(resource: Resource): Record<string, unknown> {
  return (resource.spec ?? {}) as Record<string, unknown>;
}

describe('integration: new resource types', { skip: !enabled }, () => {
  test('serviceaccounts list with their secrets lifted into spec', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'serviceaccounts',
      namespace: TEST_NAMESPACE,
    });
    const sa = byName(list, 'kdash-sa');
    assert.ok(sa, 'kdash-sa should be listed');
    assert.equal(sa.kind, 'ServiceAccount');
    assert.equal(sa.api_version, 'v1');
  });

  test('endpoints carry subsets, endpointslices carry addressType + ports', async () => {
    const endpoints = await dispatch<ResourceList>('list_resources', {
      resourceType: 'endpoints',
      namespace: TEST_NAMESPACE,
    });
    const ep = byName(endpoints, 'test-nginx-svc');
    assert.ok(ep, 'test-nginx-svc Endpoints should be listed');
    assert.ok(Array.isArray(spec(ep).subsets), 'subsets must survive the projection');

    const slices = await dispatch<ResourceList>('list_resources', {
      resourceType: 'endpointslices',
      namespace: TEST_NAMESPACE,
    });
    const slice = slices.items.find(
      (i) => (i.metadata.labels ?? {})['kubernetes.io/service-name'] === 'test-nginx-svc',
    );
    assert.ok(slice, 'an EndpointSlice for test-nginx-svc should exist');
    assert.equal(slice.kind, 'EndpointSlice');
    assert.equal(spec(slice).addressType, 'IPv4');
    assert.ok(Array.isArray(spec(slice).endpoints));
    assert.ok(Array.isArray(spec(slice).ports));
  });

  test('rolebindings keep roleRef and subjects (the synth path)', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'rolebindings',
      namespace: TEST_NAMESPACE,
    });
    const rb = byName(list, 'kdash-reader');
    assert.ok(rb);
    const roleRef = spec(rb).roleRef as { kind?: string; name?: string } | undefined;
    assert.equal(roleRef?.kind, 'Role');
    assert.equal(roleRef?.name, 'kdash-reader');
    const subjects = spec(rb).subjects as Array<{ name?: string }> | undefined;
    assert.equal(subjects?.[0]?.name, 'kdash-sa');
  });

  test('cluster-scoped additions resolve and project their table fields', async () => {
    const ingressClasses = await dispatch<ResourceList>('list_resources', {
      resourceType: 'ingressclasses',
    });
    const ic = byName(ingressClasses, 'kdash-ingressclass');
    assert.ok(ic);
    assert.equal(spec(ic).controller, 'example.com/ingress-controller');

    const priorityClasses = await dispatch<ResourceList>('list_resources', {
      resourceType: 'priorityclasses',
    });
    const pc = byName(priorityClasses, 'kdash-high');
    assert.ok(pc);
    assert.equal(spec(pc).value, 1000000);
    // globalDefault is omitempty in the API: a non-default class simply has no
    // field, which is why the column renders `=== true` rather than the value.
    assert.notEqual(spec(pc).globalDefault, true);

    const runtimeClasses = await dispatch<ResourceList>('list_resources', {
      resourceType: 'runtimeclasses',
    });
    const rc = byName(runtimeClasses, 'kdash-runtime');
    assert.ok(rc);
    assert.equal(spec(rc).handler, 'runc');

    const csiDrivers = await dispatch<ResourceList>('list_resources', {
      resourceType: 'csidrivers',
    });
    const csi = byName(csiDrivers, 'kdash.csi.example.com');
    assert.ok(csi);
    assert.equal(spec(csi).attachRequired, false);

    const webhooks = await dispatch<ResourceList>('list_resources', {
      resourceType: 'validatingwebhookconfigurations',
    });
    const wh = byName(webhooks, 'kdash-validating');
    assert.ok(wh);
    const hooks = spec(wh).webhooks as Array<{ name?: string }> | undefined;
    assert.equal(hooks?.[0]?.name, 'validate.kdash.example.com');
  });

  test('leases list (kube-node-lease has one per node)', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'leases',
      namespace: 'kube-node-lease',
    });
    assert.ok(list.items.length > 0, 'expected at least one node lease');
    const lease = list.items[0]!;
    assert.equal(lease.kind, 'Lease');
    assert.ok(spec(lease).holderIdentity, 'holderIdentity drives the Holder column');
  });

  test('storageclasses project provisioner and binding mode', async () => {
    const list = await dispatch<ResourceList>('list_resources', {
      resourceType: 'storageclasses',
    });
    assert.ok(list.items.length > 0);
    const sc = list.items[0]!;
    assert.ok(spec(sc).provisioner, 'provisioner drives the Provisioner column');
    assert.ok(spec(sc).volumeBindingMode);
  });

  test('counts come back for every new type without erroring', async () => {
    const types = [
      'serviceaccounts',
      'endpoints',
      'endpointslices',
      'ingressclasses',
      'priorityclasses',
      'runtimeclasses',
      'csidrivers',
      'volumeattachments',
      'leases',
      'mutatingwebhookconfigurations',
      'validatingwebhookconfigurations',
    ];
    const counts = await dispatch<Record<string, number>>('get_resource_counts', {
      resourceTypes: types,
      namespace: TEST_NAMESPACE,
    });
    for (const t of types) {
      assert.equal(typeof counts[t], 'number', `${t} should have a numeric count`);
    }
    assert.ok(counts['serviceaccounts']! > 0);
    assert.ok(counts['ingressclasses']! > 0);
  });

  test('a single object round-trips through get_resource / get_resource_yaml', async () => {
    const sa = await dispatch<Resource>('get_resource', {
      kind: 'ServiceAccount',
      name: 'kdash-sa',
      namespace: TEST_NAMESPACE,
    });
    assert.equal(sa.metadata.name, 'kdash-sa');

    const yaml = await dispatch<string>('get_resource_yaml', {
      kind: 'PriorityClass',
      name: 'kdash-high',
      namespace: '',
    });
    assert.match(yaml, /kind: PriorityClass/);
    assert.match(yaml, /value: 1000000/);
  });
});
