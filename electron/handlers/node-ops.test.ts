import { test, expect, describe } from 'bun:test';
import type { CoreV1Api, V1Pod } from '@kubernetes/client-node';

import type { HandlerCtx } from '../dispatch';
import type { PinnedCluster } from '../k8s/client';
import { classifyPods, drainNode } from './node-ops';

const DEFAULTS = {
  ignoreDaemonSets: true,
  deleteEmptyDirData: false,
  force: false,
  timeoutSeconds: 300,
};

function pod(name: string, extra: Partial<V1Pod> = {}): V1Pod {
  return {
    metadata: { name, namespace: 'prod', ...(extra.metadata ?? {}) },
    spec: extra.spec ?? {},
    status: extra.status ?? { phase: 'Running' },
  } as V1Pod;
}

const ownedBy = (kind: string) => ({
  metadata: {
    ownerReferences: [{ kind, name: 'owner', apiVersion: 'apps/v1', uid: 'u', controller: true }],
  },
});

describe('classifyPods', () => {
  test('evicts an ordinary controller-managed pod', () => {
    const { evictable, skipped, blockers } = classifyPods(
      [pod('web', ownedBy('ReplicaSet') as Partial<V1Pod>)],
      DEFAULTS,
    );
    expect(evictable.map((p) => p.metadata?.name)).toEqual(['web']);
    expect(skipped).toEqual([]);
    expect(blockers).toEqual([]);
  });

  test('never evicts static (mirror) pods', () => {
    const mirror = pod('kube-apiserver', {
      metadata: { name: 'kube-apiserver', annotations: { 'kubernetes.io/config.mirror': 'abc' } },
    });
    const { evictable, skipped } = classifyPods([mirror], DEFAULTS);
    expect(evictable).toEqual([]);
    expect(skipped[0]!.reason).toContain('static pod');
  });

  test('skips pods that already reached a terminal phase', () => {
    const done = pod('job-run', { ...(ownedBy('Job') as Partial<V1Pod>), status: { phase: 'Succeeded' } });
    const { evictable, skipped } = classifyPods([done], DEFAULTS);
    expect(evictable).toEqual([]);
    expect(skipped[0]!.reason).toBe('pod already succeeded');
  });

  test('DaemonSet pods skip by default and block when told not to ignore them', () => {
    const ds = pod('node-exporter', ownedBy('DaemonSet') as Partial<V1Pod>);
    expect(classifyPods([ds], DEFAULTS).skipped[0]!.reason).toBe('DaemonSet-managed');

    const strict = classifyPods([ds], { ...DEFAULTS, ignoreDaemonSets: false });
    expect(strict.evictable).toEqual([]);
    expect(strict.blockers[0]).toContain('DaemonSet-managed');
  });

  test('only the controlling owner reference counts', () => {
    // A pod can carry references that do not control it. Reading the first one
    // blindly would have let this DaemonSet pod through as "unmanaged".
    const ds = pod('node-exporter', {
      metadata: {
        ownerReferences: [
          { kind: 'ReplicaSet', name: 'decoy', apiVersion: 'apps/v1', uid: 'u1', controller: false },
          { kind: 'DaemonSet', name: 'owner', apiVersion: 'apps/v1', uid: 'u2', controller: true },
        ],
      },
    } as Partial<V1Pod>);
    expect(classifyPods([ds], DEFAULTS).skipped[0]!.reason).toBe('DaemonSet-managed');
    expect(classifyPods([ds], DEFAULTS).evictable).toEqual([]);
  });

  test('a pod owned only by non-controlling references counts as unmanaged', () => {
    const orphan = pod('adopted', {
      metadata: {
        ownerReferences: [
          { kind: 'ReplicaSet', name: 'decoy', apiVersion: 'apps/v1', uid: 'u1', controller: false },
        ],
      },
    } as Partial<V1Pod>);
    expect(classifyPods([orphan], DEFAULTS).blockers[0]).toContain('no controller');
  });

  test('an unmanaged pod blocks the drain unless force is set', () => {
    const orphan = pod('debug');
    expect(classifyPods([orphan], DEFAULTS).blockers[0]).toContain('no controller');
    expect(classifyPods([orphan], { ...DEFAULTS, force: true }).evictable).toHaveLength(1);
  });

  test('emptyDir pods block until the caller opts into losing the data', () => {
    const cached = pod('build', {
      ...(ownedBy('ReplicaSet') as Partial<V1Pod>),
      spec: { volumes: [{ name: 'scratch', emptyDir: {} }], containers: [] },
    });
    expect(classifyPods([cached], DEFAULTS).blockers[0]).toContain('emptyDir');
    expect(
      classifyPods([cached], { ...DEFAULTS, deleteEmptyDirData: true }).evictable,
    ).toHaveLength(1);
  });

  test('mirror and terminal checks win over the emptyDir/unmanaged blockers', () => {
    // A static pod with emptyDir must be SKIPPED, never a blocker — otherwise
    // every control-plane node would be undrainable.
    const staticPod = pod('etcd', {
      metadata: { name: 'etcd', annotations: { 'kubernetes.io/config.mirror': 'x' } },
      spec: { volumes: [{ name: 'scratch', emptyDir: {} }], containers: [] },
    });
    const { blockers, skipped } = classifyPods([staticPod], DEFAULTS);
    expect(blockers).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// drainNode against a fake cluster
// ---------------------------------------------------------------------------

const notFound = (): Error => Object.assign(new Error('pods not found'), { code: 404 });

/**
 * A fake cluster: the pods on the node, with each eviction "deleting" the pod.
 * `replaceOnEvict` recreates it under the same name with a new UID right away,
 * the way a StatefulSet does.
 */
function fakeCluster(pods: V1Pod[], opts: { replaceOnEvict?: boolean } = {}) {
  const live = new Map(pods.map((p) => [`${p.metadata!.namespace}/${p.metadata!.name}`, p]));
  const calls = { evictions: [] as string[], reads: 0, patches: 0 };
  let generation = 0;
  const api = {
    patchNode: async () => {
      calls.patches++;
      return {};
    },
    listPodForAllNamespaces: async () => ({ items: pods }),
    createNamespacedPodEviction: async ({ name, namespace }: { name: string; namespace: string }) => {
      const key = `${namespace}/${name}`;
      calls.evictions.push(key);
      const old = live.get(key);
      live.delete(key);
      if (opts.replaceOnEvict && old) {
        live.set(key, { ...old, metadata: { ...old.metadata, uid: `new-uid-${++generation}` } });
      }
      return {};
    },
    readNamespacedPod: async ({ name, namespace }: { name: string; namespace: string }) => {
      calls.reads++;
      const pod = live.get(`${namespace}/${name}`);
      if (!pod) throw notFound();
      return pod;
    },
  };
  return { api: api as unknown as CoreV1Api, calls };
}

function pinTo(api: CoreV1Api, context: string) {
  const state = { released: false };
  const pinned: PinnedCluster = {
    context,
    makeApiClient: () => api as never,
    release: () => {
      state.released = true;
    },
  };
  return { pinned, state };
}

const noopCtx: HandlerCtx = { emit: () => {}, mainWindow: () => null };

function sts(name: string, uid: string): V1Pod {
  return pod(name, {
    metadata: {
      name,
      uid,
      ownerReferences: [{ kind: 'StatefulSet', name: 'web', apiVersion: 'apps/v1', uid: 's', controller: true }],
    },
  } as Partial<V1Pod>);
}

describe('drainNode', () => {
  test('a StatefulSet pod recreated under the same name counts as evicted', async () => {
    // The replacement web-0 exists immediately with a new UID. Waiting for the
    // NAME to 404 would burn the whole timeout; comparing UIDs returns at once.
    const cluster = fakeCluster([sts('web-0', 'old-uid')], { replaceOnEvict: true });
    const { pinned } = pinTo(cluster.api, 'a');

    const started = Date.now();
    const result = await drainNode({ name: 'node-1', timeoutSeconds: 5 }, noopCtx, () => pinned);

    expect(result.timed_out).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.evicted).toEqual(['web-0']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('keeps waiting while the same pod (same UID) is still terminating', async () => {
    const cluster = fakeCluster([sts('web-0', 'old-uid')]);
    // Eviction accepted, but the pod lingers for one poll before it goes.
    let lingering = 1;
    const read = cluster.api.readNamespacedPod.bind(cluster.api);
    (cluster.api as unknown as { readNamespacedPod: unknown }).readNamespacedPod = async (
      args: { name: string; namespace: string },
    ) => {
      if (lingering-- > 0) return sts('web-0', 'old-uid');
      return read(args);
    };
    const { pinned } = pinTo(cluster.api, 'a');

    const result = await drainNode({ name: 'node-1', timeoutSeconds: 5 }, noopCtx, () => pinned);

    expect(result.evicted).toEqual(['web-0']);
    expect(cluster.calls.reads).toBe(1); // the post-linger read hit the real fake
  });

  test('stays on the context it started in when the active context switches', async () => {
    const clusterA = fakeCluster([sts('web-0', 'a0'), sts('web-1', 'a1'), sts('web-2', 'a2')]);
    const clusterB = fakeCluster([sts('web-0', 'b0'), sts('web-1', 'b1'), sts('web-2', 'b2')]);
    let active: 'a' | 'b' = 'a';

    // Switch the active context as soon as the first eviction lands.
    const evict = clusterA.api.createNamespacedPodEviction.bind(clusterA.api);
    (clusterA.api as unknown as { createNamespacedPodEviction: unknown }).createNamespacedPodEviction = async (
      args: { name: string; namespace: string },
    ) => {
      active = 'b';
      return evict(args as never);
    };

    const pins = { a: pinTo(clusterA.api, 'a'), b: pinTo(clusterB.api, 'b') };
    let pinCalls = 0;
    const pin = (): PinnedCluster => {
      pinCalls++;
      return pins[active].pinned;
    };

    const result = await drainNode({ name: 'node-1', timeoutSeconds: 5 }, noopCtx, pin);

    expect(pinCalls).toBe(1);
    expect(active).toBe('b');
    expect(clusterB.calls).toEqual({ evictions: [], reads: 0, patches: 0 });
    expect(clusterA.calls.evictions.sort()).toEqual(['prod/web-0', 'prod/web-1', 'prod/web-2']);
    expect(clusterA.calls.patches).toBe(1); // the cordon went to A too
    expect(result.evicted.sort()).toEqual(['web-0', 'web-1', 'web-2']);
    expect(pins.a.state.released).toBe(true);
  });

  test('releases the pinned connection when the drain aborts', async () => {
    const orphan = pod('debug'); // no controller -> blocker
    const cluster = fakeCluster([orphan]);
    const { pinned, state } = pinTo(cluster.api, 'a');

    await expect(drainNode({ name: 'node-1' }, noopCtx, () => pinned)).rejects.toThrow('Cannot drain');
    expect(state.released).toBe(true);
  });
});
