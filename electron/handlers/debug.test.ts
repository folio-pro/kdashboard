import { test, expect, describe } from 'bun:test';

import { buildDebugPatch, classifyDebugState, type EphemeralContainerStatus } from './debug';

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
