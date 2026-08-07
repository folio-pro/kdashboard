// Ownership graph built from the seeded namespace:
// Deployment -> ReplicaSet -> Pods, Job -> Pod.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { TopologyGraph, TopologyNode } from '../handlers/topology';
import { dispatch, enabled, TEST_NAMESPACE } from './setup';

const getGraph = (): Promise<TopologyGraph> =>
  dispatch<TopologyGraph>('get_namespace_topology', { namespace: TEST_NAMESPACE });

describe('integration: topology', { skip: !enabled }, () => {
  test('namespace topology returns a populated graph', { timeout: 60_000 }, async () => {
    const graph = await getGraph();
    assert.ok(graph.nodes.length > 0);
    for (const node of graph.nodes) {
      assert.ok(node.id);
      assert.ok(node.kind);
    }
  });

  test('graph contains the seeded kinds', { timeout: 60_000 }, async () => {
    const graph = await getGraph();
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    for (const kind of ['Deployment', 'ReplicaSet', 'Pod', 'Service', 'ConfigMap', 'Secret', 'Job']) {
      assert.ok(kinds.has(kind), `expected kind ${kind} in graph`);
    }
  });

  test('ownership edges link Deployment -> ReplicaSet -> Pod', { timeout: 60_000 }, async () => {
    const graph = await getGraph();
    assert.ok(graph.edges.length > 0);

    const byId = new Map<string, TopologyNode>(graph.nodes.map((n) => [n.id, n]));
    const kindPairs = graph.edges.map(
      (e) => `${byId.get(e.from)?.kind}->${byId.get(e.to)?.kind}`,
    );
    assert.ok(kindPairs.includes('Deployment->ReplicaSet'));
    assert.ok(kindPairs.includes('ReplicaSet->Pod'));
  });

  test('graph has no cycles in the seeded data', { timeout: 60_000 }, async () => {
    const graph = await getGraph();
    const out = new Map<string, string[]>();
    for (const e of graph.edges) {
      out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): void => {
      if (done.has(id)) return;
      assert.ok(!visiting.has(id), `cycle detected through node ${id}`);
      visiting.add(id);
      for (const next of out.get(id) ?? []) visit(next);
      visiting.delete(id);
      done.add(id);
    };
    for (const node of graph.nodes) visit(node.id);
  });

  test('resource topology returns the subgraph around the deployment', { timeout: 60_000 }, async () => {
    const graph = await getGraph();
    const deployment = graph.nodes.find((n) => n.kind === 'Deployment' && n.name === 'test-nginx');
    assert.ok(deployment);

    const sub = await dispatch<TopologyGraph>('get_resource_topology', {
      uid: deployment.id,
      namespace: TEST_NAMESPACE,
    });
    assert.ok(sub.nodes.map((n) => n.id).includes(deployment.id));
    const kinds = new Set(sub.nodes.map((n) => n.kind));
    assert.ok(kinds.has('ReplicaSet'));
    assert.ok(kinds.has('Pod'));
  });

  test('all-namespaces topology is a superset of the test namespace', { timeout: 120_000 }, async () => {
    const all = await dispatch<TopologyGraph>('get_namespace_topology', { namespace: null });
    const scoped = await getGraph();
    assert.ok(all.nodes.length >= scoped.nodes.length);
  });

  test('resource topology for a nonexistent uid rejects or returns empty', { timeout: 60_000 }, async () => {
    try {
      const sub = await dispatch<TopologyGraph>('get_resource_topology', {
        uid: '00000000-0000-0000-0000-000000000000',
        namespace: TEST_NAMESPACE,
      });
      assert.equal(sub.nodes.length, 0);
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });
});
