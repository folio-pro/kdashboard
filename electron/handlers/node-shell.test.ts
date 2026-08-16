import { test, expect, describe } from 'bun:test';

import { buildNodeShellPod, NODE_SHELL_LABEL } from './node-shell';

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
