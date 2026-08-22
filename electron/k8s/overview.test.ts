import { describe, expect, test } from 'bun:test';
import type { CoreV1Event, V1Deployment, V1Node, V1Pod } from '@kubernetes/client-node';

import {
  foldPodsIntoOwners,
  nodeProblems,
  orderProblems,
  podPhaseCounts,
  podProblem,
  podRequests,
  recentWarnings,
  summarizeNodes,
  workloadProblems,
} from './overview';

const node = (name: string, extra: Partial<V1Node> = {}): V1Node =>
  ({
    metadata: { name, labels: { 'node.kubernetes.io/instance-type': 'm6i.xlarge', 'topology.kubernetes.io/zone': 'eu-west-1a' }, ...(extra.metadata ?? {}) },
    spec: extra.spec ?? {},
    status: {
      allocatable: { cpu: '3900m', memory: '15Gi' },
      conditions: [{ type: 'Ready', status: 'True' }],
      nodeInfo: { kubeletVersion: 'v1.31.2' },
      ...(extra.status ?? {}),
    },
  }) as V1Node;

const pod = (name: string, extra: Partial<V1Pod> = {}): V1Pod =>
  ({
    metadata: { name, namespace: 'billing', ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7f9c8d', controller: true }], ...(extra.metadata ?? {}) },
    spec: { nodeName: 'n1', containers: [{ name: 'app', resources: { requests: { cpu: '250m', memory: '512Mi' } } }], ...(extra.spec ?? {}) },
    status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }], ...(extra.status ?? {}) },
  }) as V1Pod;

describe('nodes', () => {
  test('sums requests of the pods scheduled on each node and reads labels/conditions', () => {
    const pods = [pod('a'), pod('b', { spec: { nodeName: 'n1', containers: [{ name: 'x', resources: { requests: { cpu: '1', memory: '1Gi' } } }] } }), pod('done', { status: { phase: 'Succeeded' } })];
    const [n] = summarizeNodes([node('n1', { status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'True' }], allocatable: { cpu: '4', memory: '16Gi' } } })], pods, new Map([['n1', { cpu: 2.5, memory: 10 }]]));
    expect(n.instance_type).toBe('m6i.xlarge');
    expect(n.zone).toBe('eu-west-1a');
    expect(n.ready).toBe(true);
    expect(n.pressure).toEqual(['MemoryPressure']);
    expect(n.cpu_allocatable).toBe(4);
    expect(n.cpu_requests).toBeCloseTo(1.25);
    expect(n.memory_requests).toBe(512 * 1024 * 1024 + 1024 ** 3);
    expect(n.pod_count).toBe(2);
    expect(n.cpu_usage).toBe(2.5);
  });

  test('requests are null when pods could not be listed; NotReady and pressure become problems', () => {
    const nodes = summarizeNodes(
      [node('ok'), node('sick', { status: { conditions: [{ type: 'Ready', status: 'False' }], allocatable: {} } }), node('tight', { status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'DiskPressure', status: 'True' }], allocatable: {} } })],
      null,
      null,
    );
    expect(nodes.map((n) => n.cpu_requests)).toEqual([null, null, null]);
    expect(nodeProblems(nodes).map((p) => [p.severity, p.name, p.reason])).toEqual([
      ['critical', 'sick', 'NotReady'],
      ['warning', 'tight', 'DiskPressure'],
    ]);
  });
});

describe('pods', () => {
  test('phase counts', () => {
    expect(podPhaseCounts([pod('a'), pod('b', { status: { phase: 'Pending' } }), pod('c', { status: { phase: 'Failed' } })])).toEqual({ running: 1, pending: 1, succeeded: 0, failed: 1, unknown: 0, total: 3 });
  });

  test('podRequests sums app containers only', () => {
    expect(podRequests(pod('a', { spec: { containers: [{ name: 'a', resources: { requests: { cpu: '100m', memory: '64Mi' } } }, { name: 'b', resources: { requests: { cpu: '100m' } } }], initContainers: [{ name: 'i', resources: { requests: { cpu: '5' } } }] } }))).toEqual({ cpu: 0.2, memory: 64 * 1024 * 1024 });
  });

  test('a waiting container with a broken reason is critical, with owner and restarts', () => {
    const p = podProblem(pod('web-7f9c8d-x2k', {
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: false, restartCount: 14, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m' } }, lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date('2026-08-22T10:42:11Z') } } }],
      },
    }));
    expect(p).toMatchObject({ severity: 'critical', kind: 'Pod', reason: 'CrashLoopBackOff', detail: 'container app — back-off 5m', owner: 'Deployment/web', restarts: 14, since: '2026-08-22T10:42:11.000Z' });
    expect(p?.id).toBe('Pod/billing/web-7f9c8d-x2k');
  });

  test('unschedulable pending pods are warnings; healthy, completed and terminating pods are not problems', () => {
    const pending = podProblem(pod('p', { status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/6 nodes available' }] } }));
    expect(pending).toMatchObject({ severity: 'warning', reason: 'Unschedulable', detail: '0/6 nodes available' });
    expect(podProblem(pod('ok'))).toBeNull();
    expect(podProblem(pod('done', { status: { phase: 'Succeeded', containerStatuses: [{ name: 'a', ready: false, restartCount: 0, state: { terminated: { exitCode: 0 } } }] } }))).toBeNull();
    expect(podProblem(pod('bye', { metadata: { name: 'bye', deletionTimestamp: new Date() }, status: { phase: 'Running', containerStatuses: [{ name: 'a', ready: false, restartCount: 0, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }))).toBeNull();
  });
});

describe('workloads', () => {
  const dep = (name: string, spec: Partial<V1Deployment['spec']>, status: Partial<NonNullable<V1Deployment['status']>>): V1Deployment =>
    ({ metadata: { name, namespace: 'shop' }, spec: { replicas: 3, ...spec }, status } as V1Deployment);

  test('deployments: unavailable / failed / short of replicas; paused and scaled-to-zero skipped', () => {
    const out = workloadProblems({
      deployments: [
        dep('ok', {}, { readyReplicas: 3, conditions: [{ type: 'Available', status: 'True' }] }),
        dep('down', {}, { readyReplicas: 0, conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.' }] }),
        dep('stuck', {}, { readyReplicas: 2, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] }),
        dep('rolling', {}, { readyReplicas: 2, conditions: [{ type: 'Available', status: 'True' }, { type: 'Progressing', status: 'True', message: 'ReplicaSet "rolling-abc" is progressing.' }] }),
        dep('paused', { paused: true }, { readyReplicas: 0 }),
        dep('zero', { replicas: 0 }, {}),
      ],
    });
    expect(out.map((p) => [p.name, p.severity, p.reason, p.ready, p.desired])).toEqual([
      ['down', 'critical', 'Unavailable', 0, 3],
      ['stuck', 'critical', 'ProgressDeadlineExceeded', 2, 3],
      ['rolling', 'warning', '2/3 ready', 2, 3],
    ]);
  });

  test('statefulsets, daemonsets and failed jobs', () => {
    const out = workloadProblems({
      statefulsets: [{ metadata: { name: 'kafka', namespace: 'msg' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } } as never],
      daemonsets: [{ metadata: { name: 'fb', namespace: 'log' }, status: { desiredNumberScheduled: 6, numberReady: 0 } } as never],
      jobs: [
        { metadata: { name: 'export-1', namespace: 'billing', ownerReferences: [{ kind: 'CronJob', name: 'export' }] }, status: { failed: 3, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } } as never,
        { metadata: { name: 'flaky-ok', namespace: 'billing' }, status: { failed: 1, conditions: [{ type: 'Complete', status: 'True' }] } } as never,
      ],
    });
    expect(out.map((p) => [p.kind, p.name, p.severity, p.reason, p.owner])).toEqual([
      ['StatefulSet', 'kafka', 'warning', '2/3 ready', null],
      ['DaemonSet', 'fb', 'critical', '0/6 ready', null],
      ['Job', 'export-1', 'critical', 'BackoffLimitExceeded', 'CronJob/export'],
    ]);
  });
});

describe('events', () => {
  test('recent Warning events newest first, capped, with a total', () => {
    const ev = (reason: string, minutesAgo: number, type = 'Warning'): CoreV1Event =>
      ({ type, reason, message: 'm', count: 2, lastTimestamp: new Date(Date.now() - minutesAgo * 60_000), involvedObject: { kind: 'Pod', name: 'p', namespace: 'ns' } }) as CoreV1Event;
    const since = Date.now() - 3_600_000;
    const r = recentWarnings([ev('Old', 90), ev('BackOff', 5), ev('Pulled', 1, 'Normal'), ev('Unhealthy', 20)], since, 1);
    expect(r.total).toBe(2);
    expect(r.items.map((e) => e.reason)).toEqual(['BackOff']);
    expect(r.items[0]).toMatchObject({ kind: 'Pod', name: 'p', namespace: 'ns', count: 2 });
  });
});

describe('ordering and folding', () => {
  test('critical first, nodes before workloads before pods, oldest first', () => {
    const mk = (kind: 'Pod' | 'Deployment' | 'Node', severity: 'critical' | 'warning', name: string, since: string | null) =>
      ({ id: `${kind}//${name}`, severity, kind, name, namespace: null, reason: 'r', detail: null, owner: null, since, restarts: 0, ready: null, desired: null }) as const;
    const ordered = orderProblems([
      mk('Pod', 'warning', 'p1', null),
      mk('Pod', 'critical', 'p-new', '2026-08-22T10:00:00Z'),
      mk('Pod', 'critical', 'p-old', '2026-08-22T09:00:00Z'),
      mk('Deployment', 'critical', 'd', null),
      mk('Node', 'warning', 'n', null),
    ]);
    expect(ordered.map((p) => p.name)).toEqual(['d', 'p-old', 'p-new', 'n', 'p1']);
  });

  test('pods whose owning workload is already listed are folded away, bare pods stay', () => {
    const mk = (kind: 'Pod' | 'Deployment' | 'StatefulSet', name: string, owner: string | null) =>
      ({ id: `${kind}/ns/${name}`, severity: 'critical', kind, name, namespace: 'ns', reason: 'r', detail: null, owner, since: null, restarts: 0, ready: null, desired: null }) as const;
    const out = foldPodsIntoOwners([
      mk('Deployment', 'web', null),
      mk('Pod', 'web-7f9c8d-a', 'Deployment/web'),
      mk('Pod', 'other-1', 'Deployment/other'),
      mk('StatefulSet', 'kafka', null),
      mk('Pod', 'kafka-2', 'StatefulSet/kafka'),
      mk('Pod', 'bare', null),
    ]);
    expect(out.map((p) => p.name)).toEqual(['web', 'other-1', 'kafka', 'bare']);
  });
});
