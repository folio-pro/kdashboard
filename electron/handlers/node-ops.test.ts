import { test, expect, describe } from 'bun:test';
import type { V1Pod } from '@kubernetes/client-node';

import { classifyPods } from './node-ops';

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
