import { test, expect, describe } from 'bun:test';
import type { V1Pod } from '@kubernetes/client-node';

import { diagnosePod, diagnoseDeployment, diagnoseOwnedPods, diagnoseWorkload, diagnoseJob, diagnosePvc, diagnoseService, labelSelectorOf } from './diagnostics';

const pod = (name: string, status: V1Pod['status'], container = 'app'): V1Pod =>
  ({ metadata: { name, namespace: 'broken' }, spec: { containers: [{ name: container, resources: { limits: { memory: '10Mi' } } }] }, status }) as V1Pod;

describe('diagnoseOwnedPods / diagnoseWorkload', () => {
  test('names the real pod-level reason with a matching suggestion, one issue per distinct reason', () => {
    const v = diagnoseOwnedPods([
      pod('bad-image-1', { phase: 'Pending', containerStatuses: [{ name: 'app', image: 'ghcr.io/x/nope:1', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "ghcr.io/x/nope:1"' } } }] }),
      pod('crash-1', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 2, reason: 'Error' } } }] }),
      pod('crash-2', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 2, reason: 'Error' } } }] }),
      pod('fine', { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] }),
    ]);
    expect(v.issues.map((i) => [i.severity, i.category, i.title, i.pod?.name])).toEqual([
      ['critical', 'image', 'Pod bad-image-1: ImagePullBackOff', 'bad-image-1'],
      ['critical', 'crash', '2 pods in CrashLoopBackOff', 'crash-2'],
    ]);
    expect(v.issues[0].suggestion).toContain('ghcr.io/x/nope:1');
    expect(v.issues[1].detail).toBe('container app — last exit: Error (2) · 9 restarts · worst: crash-2');
    expect(v.issues[1].suggestion).toBe('Read the container logs; last exit code 2 (Error).');
    // The overall verdict is the worst pod: most restarts among criticals.
    expect(v.cause).toBe('crash');
    expect(v.pod).toEqual({ name: 'crash-2', namespace: 'broken', container: 'app' });
  });

  test('missing secret, OOM and unschedulable each get their own cause and advice', () => {
    const v = diagnoseOwnedPods([
      pod('missing-secret-1', { phase: 'Pending', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'CreateContainerConfigError', message: 'secret "ghost" not found' } } }] }),
      pod('oom-1', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] }),
      pod('unschedulable-1', { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes are available: 1 Insufficient cpu.' }] }),
    ]);
    const byCat = Object.fromEntries(v.issues.map((i) => [i.category, i]));
    expect(byCat['config'].suggestion).toBe('Create secret "ghost" in namespace "broken" or fix the reference in the pod spec.');
    expect(byCat['oom'].suggestion).toBe('Raise the memory limit (currently 10Mi) on container app or fix the memory leak.');
    expect(byCat['scheduling'].suggestion).toBe('The scheduler says: 0/1 nodes are available: 1 Insufficient cpu.');
    expect(byCat['scheduling'].severity).toBe('warning');
  });

  test('a workload keeps the replica count but drops the generic "no available replicas" once pods explain it', () => {
    const deployment = { spec: { replicas: 1 }, status: { readyReplicas: 0, conditions: [{ type: 'Available', status: 'False', message: 'Deployment does not have minimum availability.' }] } };
    const withPods = diagnoseWorkload(deployment, [pod('bad-image-1', { phase: 'Pending', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }] })]);
    expect(withPods.issues.map((i) => i.title)).toEqual(['Pod bad-image-1: ImagePullBackOff', 'Only 0/1 replicas ready']);
    expect(withPods.cause).toBe('image-pull');
    const alone = diagnoseWorkload(deployment, []);
    expect(alone.issues.map((i) => i.title)).toEqual(['Deployment has no available replicas', 'Only 0/1 replicas ready']);
    expect(alone.cause).toBe('unknown');
    expect(alone.pod).toBeNull();
    const stuck = diagnoseWorkload({ spec: { replicas: 1 }, status: { conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'timed out' }] } }, []);
    expect(stuck.cause).toBe('progress-deadline');
  });
});

describe('diagnoseJob', () => {
  const job = { spec: { backoffLimit: 2 }, status: { failed: 3, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] } };

  test('reports failed pod count, the last termination and which pod to open', () => {
    const v = diagnoseJob(job, [
      pod('failing-job-old', { phase: 'Failed', containerStatuses: [{ name: 'main', ready: false, restartCount: 0, state: { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date('2026-08-22T10:00:00Z') } } }] }, 'main'),
      pod('failing-job-new', { phase: 'Failed', containerStatuses: [{ name: 'main', ready: false, restartCount: 0, state: { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date('2026-08-22T11:00:00Z') } } }] }, 'main'),
    ]);
    expect(v.cause).toBe('job-failed');
    expect(v.pod).toEqual({ name: 'failing-job-new', namespace: 'broken', container: 'main' });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]).toMatchObject({ severity: 'critical', category: 'job', title: 'Job failed: BackoffLimitExceeded', pod: { name: 'failing-job-new' } });
    expect(v.issues[0].detail).toBe('Job has reached the specified backoff limit · 3 failed pods (backoffLimit 2) · last pod failing-job-new: Error — container main');
    expect(v.issues[0].suggestion).toBe('Read the logs of pod failing-job-new (container main); it ended with exit code 1 (Error). A failed Job does not retry until it is recreated.');
  });

  test('without pods it still explains the failure; a healthy job has no verdict', () => {
    const v = diagnoseJob(job, []);
    expect(v.cause).toBe('job-failed');
    expect(v.pod).toBeNull();
    expect(v.issues[0].suggestion).toContain('failed pods are gone');
    expect(diagnoseJob({ status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } }, [])).toEqual({ issues: [], cause: 'unknown', pod: null });
  });
});

describe('diagnosePvc / diagnoseService', () => {
  test('a Pending PVC quotes the provisioner and names the missing storage class', () => {
    const v = diagnosePvc({ spec: { storageClassName: 'does-not-exist' }, status: { phase: 'Pending' } }, [{ reason: 'ProvisioningFailed', message: 'storageclass.storage.k8s.io "does-not-exist" not found', type_: 'Warning', count: 12 }]);
    expect(v.cause).toBe('pvc-pending');
    expect(v.issues[0]).toMatchObject({ severity: 'critical', category: 'storage', title: 'Volume provisioning failed', detail: 'storageclass.storage.k8s.io "does-not-exist" not found' });
    expect(v.issues[0].suggestion).toBe('Create storage class "does-not-exist" or point spec.storageClassName at one that exists (kubectl get storageclass).');
    expect(diagnosePvc({ status: { phase: 'Bound' } }, []).issues).toEqual([]);
    expect(diagnosePvc({ spec: { storageClassName: 'standard' }, status: { phase: 'Pending' } }, []).issues[0]).toMatchObject({ severity: 'warning', title: 'Waiting for a volume' });
  });

  test('a selector Service with no ready address, and a LoadBalancer without an address', () => {
    const orphan = diagnoseService({ spec: { type: 'ClusterIP', selector: { app: 'nope' } } }, { subsets: [] });
    expect(orphan.cause).toBe('no-endpoints');
    expect(orphan.issues[0]).toMatchObject({ severity: 'warning', category: 'network', title: 'No ready endpoints', detail: 'no ready pod carries labels app=nope' });
    const notReady = diagnoseService({ spec: { selector: { app: 'web' } } }, { subsets: [{ notReadyAddresses: [{ ip: '10.0.0.1' }] }] });
    expect(notReady.issues[0].detail).toBe('1 pod matches selector app=web but is not ready');
    const lb = diagnoseService({ spec: { type: 'LoadBalancer', selector: { app: 'api' } }, status: { loadBalancer: {} } }, { subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] });
    expect(lb.cause).toBe('lb-pending');
    expect(lb.issues.map((i) => i.title)).toEqual(['LoadBalancer has no external address']);
    const both = diagnoseService({ spec: { type: 'LoadBalancer', selector: { app: 'api' } } }, { subsets: [] });
    expect(both.cause).toBe('no-endpoints');
    expect(both.issues).toHaveLength(2);
    // Endpoints unreadable, ExternalName, or no selector: nothing to say about endpoints.
    expect(diagnoseService({ spec: { selector: { app: 'x' } } }, null).issues).toEqual([]);
    expect(diagnoseService({ spec: { type: 'ExternalName', selector: { app: 'x' } } }, { subsets: [] }).issues).toEqual([]);
    expect(diagnoseService({ spec: {} }, { subsets: [] }).issues).toEqual([]);
  });

  test('labelSelectorOf reads matchLabels', () => {
    expect(labelSelectorOf({ spec: { selector: { matchLabels: { app: 'web', tier: 'api' } } } })).toBe('app=web,tier=api');
    expect(labelSelectorOf({ spec: { selector: { matchLabels: {} } } })).toBeNull();
    expect(labelSelectorOf({ spec: {} })).toBeNull();
  });
});

describe('diagnosePod', () => {
  test('flags CrashLoopBackOff as critical', () => {
    const issues = diagnosePod({
      status: {
        containerStatuses: [
          { name: 'app', restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } } },
        ],
      },
    });
    const crash = issues.find((i) => i.category === 'crash' && i.title.includes('CrashLoopBackOff'));
    expect(crash?.severity).toBe('critical');
  });

  test('flags ImagePullBackOff as critical image issue', () => {
    const issues = diagnosePod({
      status: {
        containerStatuses: [
          { name: 'app', image: 'foo:bad', state: { waiting: { reason: 'ImagePullBackOff' } } },
        ],
      },
    });
    expect(issues.some((i) => i.category === 'image' && i.severity === 'critical')).toBe(true);
  });

  test('flags OOMKilled from lastState terminated', () => {
    const issues = diagnosePod({
      status: {
        containerStatuses: [
          { name: 'app', lastState: { terminated: { reason: 'OOMKilled' } } },
        ],
      },
    });
    expect(issues.some((i) => i.category === 'oom' && i.severity === 'critical')).toBe(true);
  });

  test('flags high restart count as a warning', () => {
    const issues = diagnosePod({
      status: { containerStatuses: [{ name: 'app', restartCount: 6, state: {} }] },
    });
    expect(issues.some((i) => i.severity === 'warning' && i.title.includes('6 restarts'))).toBe(true);
  });

  test('flags unschedulable pods as critical', () => {
    const issues = diagnosePod({
      status: { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'no nodes' }] },
    });
    expect(issues.some((i) => i.category === 'scheduling' && i.severity === 'critical')).toBe(true);
  });

  test('flags missing resource limits as info', () => {
    const issues = diagnosePod({
      status: {},
      spec: { containers: [{ name: 'app', resources: {} }] },
    });
    expect(issues.some((i) => i.category === 'resources' && i.severity === 'info')).toBe(true);
  });

  test('healthy pod yields no issues', () => {
    const issues = diagnosePod({
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', restartCount: 0, ready: true, state: { running: {} } }],
      },
      spec: { containers: [{ name: 'app', resources: { limits: { cpu: '1', memory: '256Mi' } } }] },
    });
    expect(issues).toEqual([]);
  });

  test('no status -> no issues', () => {
    expect(diagnosePod({})).toEqual([]);
  });
});

describe('diagnoseDeployment', () => {
  test('flags ProgressDeadlineExceeded as critical', () => {
    const issues = diagnoseDeployment({
      status: {
        conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'stuck' }],
      },
    });
    expect(issues.some((i) => i.severity === 'critical' && i.title.includes('deadline'))).toBe(true);
  });

  test('flags no available replicas as critical', () => {
    const issues = diagnoseDeployment({
      status: { conditions: [{ type: 'Available', status: 'False', message: 'down' }] },
    });
    expect(issues.some((i) => i.category === 'readiness' && i.severity === 'critical')).toBe(true);
  });

  test('flags replica mismatch as a warning', () => {
    const issues = diagnoseDeployment({ spec: { replicas: 3 }, status: { readyReplicas: 1 } });
    expect(issues.some((i) => i.severity === 'warning' && i.title.includes('1/3'))).toBe(true);
  });

  test('all replicas ready -> no replica-mismatch warning', () => {
    const issues = diagnoseDeployment({ spec: { replicas: 3 }, status: { readyReplicas: 3, conditions: [] } });
    expect(issues).toEqual([]);
  });
});
