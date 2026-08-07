import { test, expect, describe } from 'bun:test';

import { diagnosePod, diagnoseDeployment } from './diagnostics';

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
