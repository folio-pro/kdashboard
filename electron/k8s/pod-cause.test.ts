import { describe, expect, test } from 'bun:test';
import type { V1Pod } from '@kubernetes/client-node';

import { classifyCause, podCause, suggestionFor, worstPodCause } from './pod-cause';

const pod = (name: string, extra: Partial<V1Pod> = {}): V1Pod =>
  ({
    metadata: { name, namespace: 'broken', ...(extra.metadata ?? {}) },
    spec: { containers: [{ name: 'app', image: 'ghcr.io/acme/app:v9', resources: { limits: { memory: '10Mi' } } }], ...(extra.spec ?? {}) },
    status: { phase: 'Running', ...(extra.status ?? {}) },
  }) as V1Pod;

describe('classifyCause', () => {
  test('maps container reasons to causes', () => {
    expect(classifyCause('ImagePullBackOff')).toBe('image-pull');
    expect(classifyCause('ErrImagePull')).toBe('image-pull');
    expect(classifyCause('InvalidImageName')).toBe('image-pull');
    expect(classifyCause('CreateContainerConfigError')).toBe('config');
    expect(classifyCause('CrashLoopBackOff')).toBe('crash');
    expect(classifyCause('Error')).toBe('crash');
    expect(classifyCause('ContainerCannotRun')).toBe('crash');
    expect(classifyCause('OOMKilled')).toBe('oom');
    expect(classifyCause('Unschedulable')).toBe('unschedulable');
    expect(classifyCause('Evicted')).toBe('unknown');
    expect(classifyCause(undefined)).toBe('unknown');
  });

  test('a crash loop whose last exit was an OOM kill is a memory problem', () => {
    expect(classifyCause('CrashLoopBackOff', 'OOMKilled')).toBe('oom');
    expect(classifyCause('CrashLoopBackOff', 'Error')).toBe('crash');
    // The current reason wins over history: a new image that cannot be pulled is not an OOM.
    expect(classifyCause('ImagePullBackOff', 'OOMKilled')).toBe('image-pull');
  });
});

describe('podCause', () => {
  test('ImagePullBackOff: image-pull with the image name in the suggestion', () => {
    const c = podCause(pod('bad-image-7f9c8d-x2k', {
      status: { phase: 'Pending', containerStatuses: [{ name: 'app', image: 'ghcr.io/acme/nope:latest', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "ghcr.io/acme/nope:latest"' } } }] },
    }));
    expect(c).toMatchObject({ cause: 'image-pull', severity: 'critical', reason: 'ImagePullBackOff', detail: 'container app — Back-off pulling image "ghcr.io/acme/nope:latest"', pod: { name: 'bad-image-7f9c8d-x2k', namespace: 'broken', container: 'app' } });
    expect(c?.suggestion).toContain('ghcr.io/acme/nope:latest');
    expect(c?.suggestion).toContain('imagePullSecrets');
  });

  test('CreateContainerConfigError: config, naming the missing secret', () => {
    const c = podCause(pod('missing-secret-1', {
      status: { phase: 'Pending', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'CreateContainerConfigError', message: 'secret "ghost" not found' } } }] },
    }));
    expect(c?.cause).toBe('config');
    expect(c?.suggestion).toBe('Create secret "ghost" in namespace "broken" or fix the reference in the pod spec.');
  });

  test('CrashLoopBackOff: crash with the last exit code, dated from the last termination', () => {
    const c = podCause(pod('crashloop-1', {
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: false, restartCount: 14, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m' } }, lastState: { terminated: { exitCode: 2, reason: 'Error', finishedAt: new Date('2026-08-22T10:42:11Z') } } }],
      },
    }));
    expect(c).toMatchObject({ cause: 'crash', reason: 'CrashLoopBackOff', restarts: 14, exitCode: 2, since: '2026-08-22T10:42:11.000Z' });
    expect(c?.suggestion).toBe('Read the container logs; last exit code 2 (Error).');
  });

  test('OOMKilled behind a crash loop: oom, quoting the current memory limit', () => {
    const c = podCause(pod('oom-1', {
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }],
      },
    }));
    expect(c).toMatchObject({ cause: 'oom', reason: 'CrashLoopBackOff', detail: 'container app — last exit: OOMKilled (137)' });
    expect(c?.suggestion).toBe('Raise the memory limit (currently 10Mi) on container app or fix the memory leak.');
  });

  test('a pod terminated non-zero (a job pod) is a crash with its exit code', () => {
    const c = podCause(pod('failing-job-abc', {
      status: { phase: 'Failed', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date('2026-08-22T11:00:00Z') } } }] },
    }));
    expect(c).toMatchObject({ cause: 'crash', reason: 'Error', exitCode: 1, detail: 'container app', pod: { container: 'app' } });
  });

  test('unschedulable: warning quoting the scheduler', () => {
    const c = podCause(pod('unschedulable-1', {
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes are available: 1 Insufficient cpu.' }] },
    }));
    expect(c).toMatchObject({ cause: 'unschedulable', severity: 'warning', reason: 'Unschedulable', pod: { container: null } });
    expect(c?.suggestion).toBe('The scheduler says: 0/1 nodes are available: 1 Insufficient cpu.');
  });

  test('healthy and terminating pods have no cause', () => {
    expect(podCause(pod('ok', { status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] } }))).toBeNull();
    expect(podCause(pod('bye', { metadata: { name: 'bye', deletionTimestamp: new Date() }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }))).toBeNull();
  });
});

describe('suggestionFor', () => {
  test('config: missing key and generic wording', () => {
    expect(suggestionFor('config', { container: 'app', namespace: 'ns', message: "couldn't find key API_KEY in Secret ns/creds" })).toBe('Add key "API_KEY" to Secret ns/creds or fix the reference in the pod spec.');
    expect(suggestionFor('config', { container: 'app', namespace: 'ns', message: '' })).toBe('Check that the referenced ConfigMaps, Secrets and volumes exist.');
  });
  test('oom without a limit says so', () => {
    expect(suggestionFor('oom', { container: null, namespace: 'ns' })).toBe('Raise the memory limit (currently unset) or fix the memory leak.');
  });
});

describe('worstPodCause', () => {
  const mk = (over: Partial<ReturnType<typeof podCause>> & { severity: 'critical' | 'warning'; restarts: number; since: string | null; name: string }) =>
    ({ cause: 'crash', reason: 'r', detail: null, suggestion: '', exitCode: null, ...over, pod: { name: over.name, namespace: 'ns', container: null } }) as NonNullable<ReturnType<typeof podCause>>;

  test('critical beats warning, then more restarts, then most recent', () => {
    const warn = mk({ name: 'w', severity: 'warning', restarts: 99, since: '2026-08-22T12:00:00Z' });
    const few = mk({ name: 'few', severity: 'critical', restarts: 2, since: '2026-08-22T12:00:00Z' });
    const many = mk({ name: 'many', severity: 'critical', restarts: 9, since: '2026-08-22T09:00:00Z' });
    const manyNewer = mk({ name: 'newer', severity: 'critical', restarts: 9, since: '2026-08-22T11:00:00Z' });
    expect(worstPodCause([warn, few, many, manyNewer])?.pod.name).toBe('newer');
    expect(worstPodCause([warn])?.pod.name).toBe('w');
    expect(worstPodCause([])).toBeNull();
    expect(worstPodCause(undefined)).toBeNull();
  });
});
