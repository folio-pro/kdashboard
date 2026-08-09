// Integration: cordon / uncordon / drain against a live multi-node cluster.
//
// These tests MUTATE the cluster (they evict pods), so they only run against
// the disposable Kind cluster the suite seeds. Every test uncordons what it
// cordoned, so the cluster is left schedulable.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { DrainResult } from '../handlers/node-ops';
import type { Resource, ResourceList } from '../k8s/resource-types';
import { dispatch, emitted, enabled, TEST_NAMESPACE, waitFor } from './setup';

async function nodes(): Promise<Resource[]> {
  const list = await dispatch<ResourceList>('list_resources', { resourceType: 'nodes' });
  return list.items;
}

/** A worker node (never the control plane — draining that breaks the suite). */
async function workerNames(): Promise<string[]> {
  return (await nodes())
    .filter((n) => !('node-role.kubernetes.io/control-plane' in (n.metadata.labels ?? {})))
    .map((n) => n.metadata.name as string);
}

async function isUnschedulable(name: string): Promise<boolean> {
  const node = await dispatch<Resource>('get_resource', { kind: 'Node', name, namespace: '' });
  return (node.spec as { unschedulable?: boolean } | undefined)?.unschedulable === true;
}

async function podsOn(node: string): Promise<Resource[]> {
  const list = await dispatch<ResourceList>('list_resources', {
    resourceType: 'pods',
    namespace: TEST_NAMESPACE,
  });
  return list.items.filter((p) => (p.spec as { nodeName?: string } | undefined)?.nodeName === node);
}

/** Node currently running the named pod, or undefined if it is gone. */
async function nodeOf(podName: string, { prefix = false } = {}): Promise<string | undefined> {
  const list = await dispatch<ResourceList>('list_resources', {
    resourceType: 'pods',
    namespace: TEST_NAMESPACE,
  });
  const pod = list.items.find((p) => {
    const name = p.metadata.name ?? '';
    const running = (p.status as { phase?: string } | undefined)?.phase === 'Running';
    return running && (prefix ? name.startsWith(podName) : name === podName);
  });
  return (pod?.spec as { nodeName?: string } | undefined)?.nodeName;
}

// The drain rules that matter (no controller, emptyDir data) need a pod that
// nothing recreates — which means the suite has to own it. Pinning it to a
// chosen node also makes every assertion below deterministic instead of
// depending on where the scheduler happened to place a seed pod.
const PROBE_POD = 'kdash-drain-probe';

function probeManifest(node: string): string {
  return `
apiVersion: v1
kind: Pod
metadata:
  name: ${PROBE_POD}
  namespace: ${TEST_NAMESPACE}
spec:
  nodeName: ${node}
  terminationGracePeriodSeconds: 1
  containers:
    - name: busybox
      image: busybox:1.36
      command: ["sh", "-c", "sleep 100000"]
      volumeMounts:
        - name: scratch
          mountPath: /scratch
  volumes:
    - name: scratch
      emptyDir: {}
`;
}

describe('integration: node ops', { skip: !enabled }, () => {
  /** The worker the probe pod lives on; every drain test targets it. */
  let target = '';

  /** Skip a test (rather than fail it) when the cluster has no worker node. */
  function skipWithoutWorker(t: { skip: (reason?: string) => void }): boolean {
    if (target) return false;
    t.skip('cluster has no worker node to drain');
    return true;
  }

  /**
   * Register the uncordon for a node as test teardown. Doing it on the last
   * line of each test only covers the pass path: one failed assertion would
   * leave the node cordoned and every later test failing for that reason.
   */
  function uncordonAfter(t: { after: (fn: () => Promise<void>) => void }, node: string): void {
    t.after(async () => {
      await dispatch('cordon_node', { name: node, unschedulable: false });
    });
  }

  async function createProbe(): Promise<void> {
    await dispatch('apply_yaml', { yaml: probeManifest(target) });
    await waitFor(
      async () => (await nodeOf(PROBE_POD)) === target,
      { timeoutMs: 90_000, label: `${PROBE_POD} to be running on ${target}` },
    );
  }

  async function deleteProbe(): Promise<void> {
    await dispatch('delete_resource', {
      kind: 'Pod',
      name: PROBE_POD,
      namespace: TEST_NAMESPACE,
    }).catch(() => {
      // Already evicted by a drain — that is the expected end state.
    });
  }

  before(async () => {
    const workers = await workerNames();
    // Draining the control plane would take the apiserver's own workloads with
    // it, so a single-node cluster simply has nothing safe to drain.
    if (workers.length === 0) return;
    target = workers[0]!;
    await deleteProbe();
    await createProbe();
  });

  after(async () => {
    if (!target) return;
    await deleteProbe();
    for (const name of await workerNames()) {
      await dispatch('cordon_node', { name, unschedulable: false });
    }
  });

  test('cordon marks the node unschedulable, uncordon clears it', async (t) => {
    if (skipWithoutWorker(t)) return;
    uncordonAfter(t, target);

    await dispatch('cordon_node', { name: target, unschedulable: true });
    assert.equal(await isUnschedulable(target), true);

    await dispatch('cordon_node', { name: target, unschedulable: false });
    assert.equal(await isUnschedulable(target), false);
  });

  test('cordoning an unknown node fails loudly', async () => {
    await assert.rejects(() => dispatch('cordon_node', { name: 'no-such-node' }));
  });

  test('a pod with no controller blocks the drain and names itself', async (t) => {
    if (skipWithoutWorker(t)) return;
    uncordonAfter(t, target);
    await assert.rejects(
      () => dispatch('drain_node', { name: target }),
      (err: Error) => {
        assert.match(err.message, /Cannot drain/);
        assert.match(err.message, new RegExp(PROBE_POD));
        assert.match(err.message, /no controller/);
        return true;
      },
    );

    // kubectl leaves the node cordoned after a blocked drain; so do we.
    assert.equal(await isUnschedulable(target), true);
  });

  test('an emptyDir pod blocks until the caller opts into losing the data', async (t) => {
    if (skipWithoutWorker(t)) return;
    uncordonAfter(t, target);

    // force clears the no-controller blocker, leaving emptyDir as the reason.
    await assert.rejects(() => dispatch('drain_node', { name: target, force: true }), /emptyDir/);
  });

  test('drain evicts, skips DaemonSets, and reports progress', async (t) => {
    if (skipWithoutWorker(t)) return;
    uncordonAfter(t, target);
    const node = target;
    const before = await podsOn(node);
    assert.ok(before.length > 0, 'the node should be running seed pods');

    emitted.length = 0;
    const result = await dispatch<DrainResult>('drain_node', {
      name: node,
      force: true,
      deleteEmptyDirData: true,
      ignoreDaemonSets: true,
      timeoutSeconds: 45,
    });

    assert.equal(result.node, node);
    assert.ok(result.evicted.length > 0, 'expected at least one eviction');
    assert.ok(result.evicted.includes(PROBE_POD), 'the probe pod should be evicted');
    assert.equal(await isUnschedulable(node), true, 'a drained node stays cordoned');

    // kube-proxy runs as a DaemonSet on every node — it must be skipped, never
    // evicted, or the node loses networking for nothing.
    const skippedReasons = result.skipped.map((s) => s.reason);
    assert.ok(
      skippedReasons.some((r) => r.includes('DaemonSet')),
      `expected DaemonSet skips, got ${JSON.stringify(result.skipped)}`,
    );

    const progress = emitted.filter((e) => e.channel === 'node-drain-progress');
    assert.ok(progress.length >= 3, 'cordoning + listing + evicting should all report');
    const phases = progress.map((p) => (p.payload as { phase: string }).phase);
    assert.ok(phases.includes('cordoning'));
    assert.ok(phases.includes('listing'));
    assert.ok(phases.includes('done'));

    // The evicted workloads come back — on the other worker, since this one is
    // cordoned. That is the whole point of the operation.
    await waitFor(
      async () => {
        const remaining = await podsOn(node);
        return remaining.every((p) => {
          const owner = (p.metadata.owner_references as Array<{ kind?: string }> | null) ?? [];
          return owner.some((o) => o.kind === 'DaemonSet');
        });
      },
      { timeoutMs: 60_000, label: 'the drained node to hold only DaemonSet pods' },
    );
  });

  test('a PodDisruptionBudget blocks eviction until the drain times out', async (t) => {
    if (skipWithoutWorker(t)) return;
    const node = await waitFor(async () => nodeOf('guarded-', { prefix: true }), {
      timeoutMs: 90_000,
      label: 'the guarded pod to be scheduled',
    });
    // The guarded pod is not pinned, so the scheduler decides where it runs.
    // Draining the control plane would take the apiserver's own workloads with
    // it, so only proceed when it landed on a worker.
    if (!(await workerNames()).includes(node)) {
      t.skip(`guarded pod runs on ${node}, which is not a worker`);
      return;
    }
    uncordonAfter(t, node);

    // minAvailable == replicas, so every eviction gets a 429 and the drain can
    // only give up when its budget runs out.
    const result = await dispatch<DrainResult>('drain_node', {
      name: node,
      force: true,
      deleteEmptyDirData: true,
      timeoutSeconds: 12,
    });

    const guarded = result.failed.find((f) => f.pod.startsWith('guarded'));
    assert.ok(guarded, `expected the guarded pod to fail, got ${JSON.stringify(result)}`);
    assert.match(guarded.error, /PodDisruptionBudget|timed out/);
  });
});
