import { test, expect, describe } from 'bun:test';

import type { CoreV1Api } from '@kubernetes/client-node';

import type { PinnedCluster } from '../k8s/client';
import { buildDebugPatch, classifyDebugState, debugPod, type EphemeralContainerStatus } from './debug';

describe('buildDebugPatch', () => {
  test('carries only the new container, merged by name', () => {
    const patch = buildDebugPatch('debug-abc123', 'busybox:1.36', 'app') as {
      spec: { ephemeralContainers: Array<Record<string, unknown>> };
    };
    expect(patch.spec.ephemeralContainers).toHaveLength(1);
    expect(patch.spec.ephemeralContainers[0]).toMatchObject({
      name: 'debug-abc123',
      image: 'busybox:1.36',
      targetContainerName: 'app',
      imagePullPolicy: 'IfNotPresent',
    });
  });

  test('omits targetContainerName when there is no target', () => {
    const patch = buildDebugPatch('debug-abc123', 'busybox:1.36', undefined) as {
      spec: { ephemeralContainers: Array<Record<string, unknown>> };
    };
    expect('targetContainerName' in patch.spec.ephemeralContainers[0]!).toBe(false);
  });

  test('keeps the container alive with a portable sleep (no `sleep infinity`)', () => {
    const patch = buildDebugPatch('d', 'busybox:1.36', undefined) as {
      spec: { ephemeralContainers: Array<{ command: string[] }> };
    };
    expect(patch.spec.ephemeralContainers[0]!.command).toEqual(['sh', '-c', 'sleep 2147483647']);
  });
});

describe('classifyDebugState', () => {
  const status = (state: EphemeralContainerStatus['state']): EphemeralContainerStatus => ({
    name: 'debug-abc123',
    state,
  });

  test('running is running', () => {
    expect(classifyDebugState(status({ running: { startedAt: 'now' } }))).toEqual({ kind: 'running' });
  });

  test('no status yet is pending', () => {
    expect(classifyDebugState(undefined)).toEqual({ kind: 'pending', detail: 'not yet reported' });
  });

  test('ordinary waiting reasons stay pending', () => {
    expect(classifyDebugState(status({ waiting: { reason: 'ContainerCreating' } }))).toEqual({
      kind: 'pending',
      detail: 'ContainerCreating',
    });
  });

  test('image pull failures fail fast with the reason', () => {
    const verdict = classifyDebugState(
      status({ waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "nope"' } }),
    );
    expect(verdict.kind).toBe('failed');
    expect((verdict as { message: string }).message).toContain('Back-off pulling image');
  });

  test('terminations surface reason and exit code', () => {
    const verdict = classifyDebugState(status({ terminated: { reason: 'Error', exitCode: 127 } }));
    expect(verdict).toEqual({
      kind: 'failed',
      message: 'Debug container terminated (Error, exit code 127)',
    });
  });
});

describe('debugPod', () => {
  /** Fake cluster whose debug container reports `running` on the Nth read. */
  function fakeCluster(runningOnRead: number) {
    const calls = { patches: 0, reads: 0 };
    let container = '';
    const api = {
      patchNamespacedPodEphemeralcontainers: async ({ body }: { body: { spec: { ephemeralContainers: Array<{ name: string }> } } }) => {
        calls.patches++;
        container = body.spec.ephemeralContainers[0]!.name;
        return {};
      },
      readNamespacedPod: async () => {
        calls.reads++;
        const state = calls.reads >= runningOnRead ? { running: {} } : { waiting: { reason: 'ContainerCreating' } };
        return { status: { ephemeralContainerStatuses: [{ name: container, state }] } };
      },
    };
    return { api: api as unknown as CoreV1Api, calls };
  }

  test('polls the cluster it started on after the active context switches', async () => {
    const a = fakeCluster(2);
    const b = fakeCluster(1);
    let active: 'a' | 'b' = 'a';
    const released: string[] = [];
    const pinned = (ctx: 'a' | 'b'): PinnedCluster => ({
      context: ctx,
      makeApiClient: () => ({ a, b })[ctx].api as never,
      release: () => released.push(ctx),
    });
    // Switch contexts right after the patch lands, before the first poll.
    const patch = a.api.patchNamespacedPodEphemeralcontainers.bind(a.api);
    (a.api as unknown as { patchNamespacedPodEphemeralcontainers: unknown }).patchNamespacedPodEphemeralcontainers =
      async (...args: Parameters<typeof patch>) => {
        const out = await patch(...args);
        active = 'b';
        return out;
      };

    const { container } = await debugPod({ name: 'web', namespace: 'prod' }, () => pinned(active));

    expect(container).toMatch(/^debug-/);
    expect(active).toBe('b');
    expect(a.calls).toEqual({ patches: 1, reads: 2 });
    expect(b.calls).toEqual({ patches: 0, reads: 0 });
    expect(released).toEqual(['a']);
  });
});
