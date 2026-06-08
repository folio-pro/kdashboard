import { test, expect, describe } from 'bun:test';

import { buildGraph, rawFromDynamic, extractStatusStr } from './topology';

// A RawResource factory (the shape buildGraph consumes).
function res(
  uid: string,
  kind: string,
  name: string,
  ownerUids: Array<[string, string, string]> = [],
): {
  uid: string;
  kind: string;
  name: string;
  namespace?: string;
  api_version: string;
  status?: string;
  owner_refs: Array<{ uid: string; kind: string; name: string; api_version: string }>;
} {
  return {
    uid,
    kind,
    name,
    namespace: 'default',
    api_version: 'v1',
    owner_refs: ownerUids.map(([u, k, n]) => ({ uid: u, kind: k, name: n, api_version: 'v1' })),
  };
}

describe('buildGraph — owner-reference edges + roots + depth', () => {
  test('builds an owner chain Deployment -> ReplicaSet -> Pod', () => {
    const g = buildGraph(
      [
        res('d', 'Deployment', 'web'),
        res('r', 'ReplicaSet', 'web-abc', [['d', 'Deployment', 'web']]),
        res('p', 'Pod', 'web-abc-123', [['r', 'ReplicaSet', 'web-abc']]),
      ],
      false,
    );

    expect(g.total_resources).toBe(3);
    expect(g.has_cycles).toBe(false);
    expect(g.root_ids).toEqual(['d']);
    expect(g.edges).toContainEqual({ from: 'd', to: 'r', edge_type: 'owner' });
    expect(g.edges).toContainEqual({ from: 'r', to: 'p', edge_type: 'owner' });

    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('d')!.depth).toBe(0);
    expect(byId.get('r')!.depth).toBe(1);
    expect(byId.get('p')!.depth).toBe(2);
  });

  test('creates a ghost node for a missing owner', () => {
    const g = buildGraph([res('p', 'Pod', 'orphan', [['missing', 'ReplicaSet', 'gone']])], false);
    const ghost = g.nodes.find((n) => n.id === 'missing');
    expect(ghost).toBeDefined();
    expect(ghost!.is_ghost).toBe(true);
    expect(ghost!.kind).toBe('ReplicaSet');
    expect(g.nodes.find((n) => n.id === 'p')!.is_ghost).toBe(false);
  });
});

describe('buildGraph — cycle detection', () => {
  test('detects and breaks a 2-node cycle', () => {
    const g = buildGraph(
      [res('a', 'X', 'a', [['b', 'X', 'b']]), res('b', 'X', 'b', [['a', 'X', 'a']])],
      false,
    );
    expect(g.has_cycles).toBe(true);
    // One of the two mutually-referencing edges must have been dropped.
    expect(g.edges.length).toBe(1);
  });

  test('no false positive on a diamond (shared descendant, no cycle)', () => {
    // a -> b, a -> c, b -> d, c -> d (DAG, not a cycle)
    const g = buildGraph(
      [
        res('a', 'X', 'a'),
        res('b', 'X', 'b', [['a', 'X', 'a']]),
        res('c', 'X', 'c', [['a', 'X', 'a']]),
        res('d', 'X', 'd', [
          ['b', 'X', 'b'],
          ['c', 'X', 'c'],
        ]),
      ],
      false,
    );
    expect(g.has_cycles).toBe(false);
    expect(g.edges.length).toBe(4);
  });
});

describe('buildGraph — pod auto-clustering above 200 nodes', () => {
  test('clusters pods under a controller with >3 pods', () => {
    const resources = [res('ctrl', 'ReplicaSet', 'big')];
    for (let i = 0; i < 220; i++) {
      resources.push(res(`pod-${i}`, 'Pod', `p-${i}`, [['ctrl', 'ReplicaSet', 'big']]));
    }
    const g = buildGraph(resources, true);
    expect(g.clustered).toBe(true);
    expect(g.cluster_groups.length).toBe(1);
    expect(g.cluster_groups[0]!.controller_id).toBe('ctrl');
    expect(g.cluster_groups[0]!.pod_count).toBe(220);
    // Clustered pods are removed from the node set.
    expect(g.nodes.some((n) => n.kind === 'Pod')).toBe(false);
  });

  test('does not cluster below the 200-node threshold', () => {
    const resources = [res('ctrl', 'ReplicaSet', 'small')];
    for (let i = 0; i < 10; i++) {
      resources.push(res(`pod-${i}`, 'Pod', `p-${i}`, [['ctrl', 'ReplicaSet', 'small']]));
    }
    const g = buildGraph(resources, true);
    expect(g.clustered).toBe(false);
    expect(g.cluster_groups.length).toBe(0);
  });
});

describe('rawFromDynamic', () => {
  test('drops items missing uid or name (required)', () => {
    const out = rawFromDynamic('Pod', 'v1', [
      { metadata: { uid: 'u1', name: 'ok' } },
      { metadata: { uid: 'u2' } }, // no name -> dropped
      { metadata: { name: 'no-uid' } }, // no uid -> dropped
      'not-an-object',
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.uid).toBe('u1');
    expect(out[0]!.name).toBe('ok');
  });

  test('parses owner refs and extracts status', () => {
    const out = rawFromDynamic('Pod', 'v1', [
      {
        metadata: {
          uid: 'u1',
          name: 'web',
          ownerReferences: [{ uid: 'o1', kind: 'ReplicaSet', name: 'rs', apiVersion: 'apps/v1' }],
        },
        status: { phase: 'Running' },
      },
    ]);
    expect(out[0]!.status).toBe('Running');
    expect(out[0]!.owner_refs).toEqual([
      { uid: 'o1', kind: 'ReplicaSet', name: 'rs', api_version: 'apps/v1' },
    ]);
  });
});

describe('extractStatusStr', () => {
  test('Pod -> phase', () => {
    expect(extractStatusStr('Pod', { status: { phase: 'Running' } })).toBe('Running');
  });
  test('Deployment -> Available condition', () => {
    expect(
      extractStatusStr('Deployment', {
        status: { conditions: [{ type: 'Available', status: 'True' }] },
      }),
    ).toBe('Available');
    expect(
      extractStatusStr('Deployment', {
        status: { conditions: [{ type: 'Available', status: 'False' }] },
      }),
    ).toBe('Unavailable');
  });
  test('unknown kind -> undefined', () => {
    expect(extractStatusStr('ConfigMap', { status: {} })).toBeUndefined();
  });
});
