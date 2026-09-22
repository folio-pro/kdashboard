import { test, expect, describe, beforeEach, mock } from 'bun:test';

import type { HandlerCtx, HandlerMap } from '../dispatch';

// list_resources reaches the apiserver through apiGet; stub it so these tests
// check the query the handler builds rather than the network.
let calls: Array<{ path: string; query: Record<string, string> }> = [];
let items: unknown[] = [];

mock.module('../k8s/api', () => ({
  META_ACCEPT: 'application/json',
  apiGet: (path: string, query: Record<string, string> = {}) => {
    calls.push({ path, query: { ...query } });
    return Promise.resolve({ metadata: { resourceVersion: '7' }, items });
  },
  apiStream: () => Promise.reject(new Error('not used')),
}));

const { register } = await import('./resources');

let handlers: HandlerMap;
const ctx = { emit: () => {} } as unknown as HandlerCtx;

beforeEach(() => {
  calls = [];
  items = [];
  handlers = new Map();
  register(handlers);
});

function listResources(args: Record<string, unknown>) {
  return handlers.get('list_resources')!(args, ctx);
}

describe('list_resources — fieldSelector', () => {
  test('passes fieldSelector through as the query parameter', async () => {
    await listResources({ resourceType: 'pods', namespace: null, fieldSelector: 'spec.nodeName=node-a' });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/v1/pods');
    expect(calls[0].query.fieldSelector).toBe('spec.nodeName=node-a');
    // Pagination is unchanged by the selector.
    expect(calls[0].query.limit).toBeDefined();
  });

  test('omits fieldSelector when not given, empty, or not a string', async () => {
    await listResources({ resourceType: 'pods', namespace: null });
    await listResources({ resourceType: 'pods', namespace: null, fieldSelector: '' });
    await listResources({ resourceType: 'pods', namespace: null, fieldSelector: 42 });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect('fieldSelector' in c.query).toBe(false);
  });

  test('keeps the lean list projection', async () => {
    items = [
      {
        metadata: {
          name: 'web-0',
          namespace: 'default',
          uid: 'u1',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
        },
        spec: { nodeName: 'node-a' },
        status: { phase: 'Running' },
      },
    ];
    const result = (await listResources({
      resourceType: 'pods',
      namespace: null,
      fieldSelector: 'spec.nodeName=node-a',
    })) as { resource_type: string; resource_version?: string; items: Array<{ metadata: { annotations?: Record<string, string> } }> };
    expect(result.resource_type).toBe('pods');
    expect(result.resource_version).toBe('7');
    expect(result.items).toHaveLength(1);
    // listMetaFrom strips last-applied-configuration on the list path.
    expect(result.items[0].metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']).toBeUndefined();
  });
});
