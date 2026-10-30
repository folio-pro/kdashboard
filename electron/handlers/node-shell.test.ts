import { test, expect, describe } from 'bun:test';

import type { CoreV1Api, V1Pod } from '@kubernetes/client-node';

import type { PinnedCluster } from '../k8s/client';
import { buildNodeShellPod, NODE_SHELL_LABEL, startNodeShell } from './node-shell';

describe('buildNodeShellPod', () => {
  const pod = buildNodeShellPod('kdashboard-node-shell-abc123', 'kube-system', 'worker-1');

  test('pins to the node and enters the host namespaces', () => {
    expect(pod.spec).toMatchObject({
      nodeName: 'worker-1',
      hostPID: true,
      hostIPC: true,
      hostNetwork: true,
      restartPolicy: 'Never',
    });
  });

  test('the container is privileged and only sleeps (PTY comes from exec)', () => {
    const container = pod.spec!.containers[0]!;
    expect(container.securityContext?.privileged).toBe(true);
    expect(container.command).toEqual(['sh', '-c', 'sleep 2147483647']);
  });

  test('tolerates every taint — cordoned nodes are the point', () => {
    expect(pod.spec!.tolerations).toEqual([{ operator: 'Exists' }]);
  });

  test('carries the reaper deadline so an orphaned pod dies on its own', () => {
    expect(pod.spec!.activeDeadlineSeconds).toBe(3600);
    expect(pod.spec!.terminationGracePeriodSeconds).toBe(0);
  });

  test('is labelled for the renderer nsenter wrapper and marks its node', () => {
    expect(pod.metadata!.labels?.[NODE_SHELL_LABEL]).toBe('true');
    expect(pod.metadata!.annotations?.[NODE_SHELL_LABEL]).toBe('worker-1');
  });
});

describe('startNodeShell', () => {
  /** Fake cluster whose node-shell pod reports `phases[i]` on the i-th read. */
  function fakeCluster(phases: string[]) {
    const calls = { creates: 0, reads: 0, deletes: 0 };
    let created: V1Pod | undefined;
    const api = {
      createNamespacedPod: async ({ body }: { body: V1Pod }) => {
        calls.creates++;
        created = body;
        return body;
      },
      readNamespacedPod: async () => {
        const phase = phases[Math.min(calls.reads, phases.length - 1)];
        calls.reads++;
        return { ...created, status: { phase } };
      },
      deleteNamespacedPod: async () => {
        calls.deletes++;
        return {};
      },
    };
    return { api: api as unknown as CoreV1Api, calls };
  }

  /** A pin factory over two clusters that flips to `b` after the create. */
  function switchingPin(a: ReturnType<typeof fakeCluster>, b: ReturnType<typeof fakeCluster>) {
    let active: 'a' | 'b' = 'a';
    const released: string[] = [];
    const create = a.api.createNamespacedPod.bind(a.api);
    (a.api as unknown as { createNamespacedPod: unknown }).createNamespacedPod = async (
      ...args: Parameters<typeof create>
    ) => {
      const out = await create(...args);
      active = 'b';
      return out;
    };
    const pin = (): PinnedCluster => {
      const ctx = active;
      return {
        context: ctx,
        makeApiClient: () => ({ a, b })[ctx].api as never,
        release: () => released.push(ctx),
      };
    };
    return { pin, released, active: () => active };
  }

  test('polls the cluster the pod was created in after a context switch', async () => {
    const a = fakeCluster(['Pending', 'Running']);
    const b = fakeCluster(['Running']);
    const s = switchingPin(a, b);

    const out = await startNodeShell({ nodeName: 'worker-1' }, s.pin);

    expect(out.namespace).toBe('kube-system');
    expect(s.active()).toBe('b');
    expect(a.calls).toEqual({ creates: 1, reads: 2, deletes: 0 });
    expect(b.calls).toEqual({ creates: 0, reads: 0, deletes: 0 });
    expect(s.released).toEqual(['a']);
  });

  test('a failed startup cleans up the pod in the cluster that created it', async () => {
    const a = fakeCluster(['Failed']);
    const b = fakeCluster(['Running']);
    const s = switchingPin(a, b);

    await expect(startNodeShell({ nodeName: 'worker-1' }, s.pin)).rejects.toThrow('ended prematurely');

    expect(a.calls.deletes).toBe(1);
    expect(b.calls).toEqual({ creates: 0, reads: 0, deletes: 0 });
    expect(s.released).toEqual(['a']);
  });
});
