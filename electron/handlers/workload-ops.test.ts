import { describe, expect, test } from 'bun:test';
import type { V1ReplicaSet } from '@kubernetes/client-node';

import { revisionTemplateYaml } from './workload-ops';

function rs(template: Record<string, unknown> | undefined): V1ReplicaSet {
  return { metadata: { name: 'web-abc' }, spec: template ? { template } : {} } as unknown as V1ReplicaSet;
}

describe('revisionTemplateYaml', () => {
  test('serializes the pod template and drops the pod-template-hash label', () => {
    const yaml = revisionTemplateYaml(
      rs({
        metadata: { labels: { app: 'web', 'pod-template-hash': '7f9c8d' } },
        spec: { containers: [{ name: 'web', image: 'nginx:1.25' }] },
      }),
    );
    expect(yaml).toContain('app: web');
    expect(yaml).toContain('image: nginx:1.25');
    expect(yaml).not.toContain('pod-template-hash');
  });

  test('removes an emptied labels map and metadata rather than leaving `{}` noise', () => {
    const yaml = revisionTemplateYaml(
      rs({ metadata: { labels: { 'pod-template-hash': 'x' } }, spec: { containers: [] } }),
    );
    expect(yaml).not.toContain('metadata');
    expect(yaml.trim()).toBe('spec:\n  containers: []');
  });

  test('two revisions that differ only by hash produce identical YAML', () => {
    const a = rs({ metadata: { labels: { app: 'web', 'pod-template-hash': 'a' } }, spec: { containers: [{ image: 'x:1' }] } });
    const b = rs({ metadata: { labels: { app: 'web', 'pod-template-hash': 'b' } }, spec: { containers: [{ image: 'x:1' }] } });
    expect(revisionTemplateYaml(a)).toBe(revisionTemplateYaml(b));
  });

  test('a ReplicaSet without a template yields an empty string', () => {
    expect(revisionTemplateYaml(rs(undefined))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Job construction (trigger_cronjob / rerun_job)
// ---------------------------------------------------------------------------

import type { V1CronJob, V1Job } from '@kubernetes/client-node';
import { buildManualJob, buildRerunJob, jobGenerateName, jobNameWithSuffix } from './workload-ops';

const NOW = new Date('2026-09-04T10:00:00Z');
const TS = Math.floor(NOW.getTime() / 1000);

function cronJob(overrides: Partial<V1CronJob> = {}): V1CronJob {
  return {
    metadata: { name: 'nightly-report', namespace: 'batch', uid: 'cj-uid-1' },
    spec: {
      schedule: '0 2 * * *',
      jobTemplate: {
        metadata: { labels: { app: 'report' }, annotations: { team: 'data' } },
        spec: {
          backoffLimit: 2,
          template: {
            metadata: { labels: { app: 'report' } },
            spec: { restartPolicy: 'Never', containers: [{ name: 'run', image: 'report:1.2' }] },
          },
        },
      },
    },
    ...overrides,
  } as V1CronJob;
}

describe('jobNameWithSuffix', () => {
  test('appends the suffix with a dash', () => {
    expect(jobNameWithSuffix('nightly', 'manual-1')).toBe('nightly-manual-1');
  });

  test('trims a long base so the result fits the 63-char label limit without a trailing dash', () => {
    const base = 'a'.repeat(50) + '-' + 'b'.repeat(20);
    const name = jobNameWithSuffix(base, `manual-${TS}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith(`-manual-${TS}`)).toBe(true);
    expect(name).not.toContain(`--manual`);
  });
});

describe('jobGenerateName', () => {
  test('ends with a dash and leaves room for the apiserver\'s 5-character tail under 63', () => {
    expect(jobGenerateName('nightly-report', 'manual-1756980000')).toBe('nightly-report-manual-1756980000-');
    const long = jobGenerateName('a'.repeat(80), 'rerun-1756980000');
    expect(long.endsWith('-rerun-1756980000-')).toBe(true);
    expect(long.length + 5).toBe(63);
  });
});

describe('buildManualJob', () => {
  test('creates a Job from the jobTemplate, named, annotated and owned like kubectl create job --from', () => {
    const job = buildManualJob(cronJob(), NOW);
    expect(job.apiVersion).toBe('batch/v1');
    expect(job.kind).toBe('Job');
    expect(job.metadata?.name).toBeUndefined();
    expect(job.metadata?.generateName).toBe(`nightly-report-manual-${TS}-`);
    expect(job.metadata?.namespace).toBe('batch');
    expect(job.metadata?.labels).toEqual({ app: 'report' });
    expect(job.metadata?.annotations).toEqual({
      team: 'data',
      'cronjob.kubernetes.io/instantiate': 'manual',
    });
    expect(job.metadata?.ownerReferences).toEqual([
      { apiVersion: 'batch/v1', kind: 'CronJob', name: 'nightly-report', uid: 'cj-uid-1', controller: false, blockOwnerDeletion: false },
    ]);
    expect(job.spec?.backoffLimit).toBe(2);
    expect(job.spec?.template.spec?.containers[0].image).toBe('report:1.2');
  });

  test('copies the spec so later mutation of the CronJob does not leak into the Job', () => {
    const cj = cronJob();
    const job = buildManualJob(cj, NOW);
    cj.spec!.jobTemplate.spec!.backoffLimit = 99;
    expect(job.spec?.backoffLimit).toBe(2);
  });

  test('throws an actionable error when the CronJob has no jobTemplate.spec', () => {
    const cj = cronJob();
    cj.spec = { schedule: '* * * * *', jobTemplate: {} } as V1CronJob['spec'];
    expect(() => buildManualJob(cj, NOW)).toThrow(/no jobTemplate\.spec/);
  });

  test('throws when the CronJob has no uid to own the Job with', () => {
    const cj = cronJob({ metadata: { name: 'x', namespace: 'ns' } });
    expect(() => buildManualJob(cj, NOW)).toThrow(/metadata\.uid/);
  });
});

describe('buildRerunJob', () => {
  function failedJob(): V1Job {
    return {
      metadata: {
        name: 'import-abc',
        namespace: 'batch',
        uid: 'job-uid-1',
        resourceVersion: '123',
        creationTimestamp: new Date('2026-01-01T00:00:00Z'),
        labels: {
          app: 'import',
          'controller-uid': 'job-uid-1',
          'job-name': 'import-abc',
          'batch.kubernetes.io/controller-uid': 'job-uid-1',
          'batch.kubernetes.io/job-name': 'import-abc',
        },
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{}',
          'batch.kubernetes.io/job-tracking': '',
          owner: 'data',
        },
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'CronJob', name: 'import', uid: 'cj-1', controller: true, blockOwnerDeletion: true },
        ],
      },
      spec: {
        backoffLimit: 0,
        manualSelector: true,
        selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': 'job-uid-1' } },
        template: {
          metadata: {
            labels: {
              app: 'import',
              'controller-uid': 'job-uid-1',
              'job-name': 'import-abc',
              'batch.kubernetes.io/controller-uid': 'job-uid-1',
              'batch.kubernetes.io/job-name': 'import-abc',
            },
          },
          spec: { restartPolicy: 'Never', containers: [{ name: 'import', image: 'import:2' }] },
        },
      },
      status: { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] },
    } as unknown as V1Job;
  }

  test('strips the selector and controller labels from the Job and its pod template', () => {
    const job = buildRerunJob(failedJob(), NOW);
    expect(job.spec?.selector).toBeUndefined();
    expect(job.spec?.manualSelector).toBeUndefined();
    expect(job.metadata?.labels).toEqual({ app: 'import' });
    expect(job.spec?.template.metadata?.labels).toEqual({ app: 'import' });
  });

  test('names the new Job <job>-rerun-<ts>-<random> via generateName, keeps user annotations and drops status / server metadata', () => {
    const job = buildRerunJob(failedJob(), NOW);
    expect(job.metadata?.name).toBeUndefined();
    expect(job.metadata?.generateName).toBe(`import-abc-rerun-${TS}-`);
    expect(job.metadata?.namespace).toBe('batch');
    expect(job.metadata?.uid).toBeUndefined();
    expect(job.metadata?.resourceVersion).toBeUndefined();
    expect(job.metadata?.creationTimestamp).toBeUndefined();
    expect(job.metadata?.annotations).toEqual({ owner: 'data', 'kdashboard.io/rerun-of': 'import-abc' });
    expect((job as { status?: unknown }).status).toBeUndefined();
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.template.spec?.containers[0].image).toBe('import:2');
  });

  test('keeps the owning CronJob reference but as a non-controller owner', () => {
    const job = buildRerunJob(failedJob(), NOW);
    expect(job.metadata?.ownerReferences).toEqual([
      { apiVersion: 'batch/v1', kind: 'CronJob', name: 'import', uid: 'cj-1', controller: false, blockOwnerDeletion: false },
    ]);
  });

  test('drops owners that are not CronJobs so the garbage collector cannot take the rerun with them', () => {
    const src = failedJob();
    src.metadata!.ownerReferences = [
      { apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', name: 'nightly', uid: 'wf-1', controller: true },
      { apiVersion: 'batch/v1', kind: 'CronJob', name: 'import', uid: 'cj-1', controller: false },
    ];
    expect(buildRerunJob(src, NOW).metadata?.ownerReferences).toEqual([
      { apiVersion: 'batch/v1', kind: 'CronJob', name: 'import', uid: 'cj-1', controller: false, blockOwnerDeletion: false },
    ]);

    src.metadata!.ownerReferences = [{ apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', name: 'nightly', uid: 'wf-1', controller: true }];
    expect(buildRerunJob(src, NOW).metadata?.ownerReferences).toBeUndefined();
  });

  test('a template whose only labels were controller-owned ends up without a labels map', () => {
    const src = failedJob();
    src.spec!.template.metadata!.labels = { 'job-name': 'import-abc', 'controller-uid': 'x' };
    const job = buildRerunJob(src, NOW);
    expect(job.spec?.template.metadata).toBeUndefined();
  });

  test('throws an actionable error when the Job has no pod template', () => {
    const src = failedJob();
    src.spec = {} as V1Job['spec'];
    expect(() => buildRerunJob(src, NOW)).toThrow(/no pod template/);
  });
});
