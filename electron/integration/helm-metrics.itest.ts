// Integration: Helm release reading and the metrics endpoints.
//
// The Helm tests need real release Secrets in the cluster (the seed installs
// podinfo with two revisions); the metrics tests need metrics-server, and the
// Prometheus test only runs when KDASH_PROMETHEUS_URL points at one.

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import type { HelmRelease, HelmReleaseDetail } from '../handlers/helm';
import type { PodMetricsResult, PrometheusResult } from '../handlers/metrics';
import { setPrometheusUrl } from '../k8s/runtime-config';
import { dispatch, enabled, TEST_NAMESPACE } from './setup';

const PROMETHEUS_URL = process.env.KDASH_PROMETHEUS_URL;

describe('integration: helm', { skip: !enabled }, () => {
  /** Every assertion here needs a real release; a cluster without one skips. */
  let hasReleases = false;

  before(async () => {
    const releases = await dispatch<HelmRelease[]>('list_helm_releases', { namespace: null });
    hasReleases = releases.some((r) => r.name === 'podinfo');
  });

  function skipWithoutRelease(t: { skip: (reason?: string) => void }): boolean {
    if (hasReleases) return false;
    t.skip('no podinfo Helm release installed in this cluster');
    return true;
  }

  test('lists the releases installed in the cluster', async (t) => {
    if (skipWithoutRelease(t)) return;
    const releases = await dispatch<HelmRelease[]>('list_helm_releases', { namespace: null });
    assert.ok(releases.length > 0, 'expected at least one Helm release');

    const podinfo = releases.find((r) => r.name === 'podinfo');
    assert.ok(podinfo, 'podinfo release should be listed');
    assert.equal(podinfo.namespace, TEST_NAMESPACE);
    assert.equal(podinfo.status, 'deployed');
    assert.equal(podinfo.chart, 'podinfo');
    assert.match(podinfo.chart_version, /^\d+\.\d+\.\d+$/);
    assert.ok(podinfo.app_version.length > 0);
    assert.ok(podinfo.updated.length > 0);
  });

  test('only the latest revision shows in the list', async (t) => {
    if (skipWithoutRelease(t)) return;
    const releases = await dispatch<HelmRelease[]>('list_helm_releases', {
      namespace: TEST_NAMESPACE,
    });
    const podinfo = releases.filter((r) => r.name === 'podinfo');
    assert.equal(podinfo.length, 1, 'a release must appear once, not once per revision');
    assert.ok(podinfo[0]!.revision >= 2, 'seed upgraded podinfo, so revision >= 2');
  });

  test('namespace scoping filters the list', async (t) => {
    if (skipWithoutRelease(t)) return;
    const scoped = await dispatch<HelmRelease[]>('list_helm_releases', {
      namespace: TEST_NAMESPACE,
    });
    assert.ok(scoped.every((r) => r.namespace === TEST_NAMESPACE));
    assert.ok(!scoped.some((r) => r.name === 'prom'), 'prom lives in another namespace');
  });

  test('release detail carries values, manifest and notes', async (t) => {
    if (skipWithoutRelease(t)) return;
    const detail = await dispatch<HelmReleaseDetail>('get_helm_release', {
      name: 'podinfo',
      namespace: TEST_NAMESPACE,
    });
    assert.equal(detail.name, 'podinfo');
    // The seed upgraded with --set replicaCount=3 --set ui.message=...
    assert.equal((detail.values as { replicaCount?: number }).replicaCount, 3);
    assert.ok(Object.keys(detail.chart_values).length > 0, 'chart defaults should be present');
    assert.match(detail.manifest, /kind: Deployment/);
    assert.ok(detail.notes.length > 0, 'podinfo ships a NOTES.txt');
  });

  test('history returns every revision, newest first', async (t) => {
    if (skipWithoutRelease(t)) return;
    const history = await dispatch<HelmRelease[]>('list_helm_release_history', {
      name: 'podinfo',
      namespace: TEST_NAMESPACE,
    });
    assert.ok(history.length >= 2, 'seed installed then upgraded podinfo');
    assert.ok(history[0]!.revision > history[1]!.revision, 'newest revision first');
    assert.equal(history[0]!.status, 'deployed');
    assert.equal(history[1]!.status, 'superseded');
  });

  test('an older revision can be fetched explicitly', async (t) => {
    if (skipWithoutRelease(t)) return;
    const first = await dispatch<HelmReleaseDetail>('get_helm_release', {
      name: 'podinfo',
      namespace: TEST_NAMESPACE,
      revision: 1,
    });
    assert.equal(first.revision, 1);
    // Revision 1 was installed with replicaCount=2, the upgrade moved it to 3.
    assert.equal((first.values as { replicaCount?: number }).replicaCount, 2);
  });

  test('an unknown release errors with a useful message', async () => {
    await assert.rejects(
      () => dispatch('get_helm_release', { name: 'nope', namespace: TEST_NAMESPACE }),
      /not found in namespace/,
    );
  });
});

describe('integration: metrics', { skip: !enabled }, () => {
  /** metrics-server is optional; without it the handler reports unavailable. */
  let metricsAvailable = false;

  before(async () => {
    const result = await dispatch<PodMetricsResult>('get_pod_metrics', { namespace: TEST_NAMESPACE });
    metricsAvailable = result.available;
  });

  function skipWithoutMetrics(t: { skip: (reason?: string) => void }): boolean {
    if (metricsAvailable) return false;
    t.skip('cluster has no metrics-server');
    return true;
  }

  test('pod metrics come back from metrics.k8s.io', async (t) => {
    if (skipWithoutMetrics(t)) return;
    const result = await dispatch<PodMetricsResult>('get_pod_metrics', {
      namespace: TEST_NAMESPACE,
    });
    assert.equal(result.available, true, `metrics unavailable: ${result.reason}`);
    assert.ok(result.pods.length > 0, 'expected usage for at least one pod');

    // Any running pod will do. Naming one couples this to what the other
    // suites happen to be doing to the cluster — the drain suite reschedules
    // workloads, and a pod that just moved has no scrape yet.
    const pod = result.pods.find((p) => p.memory_bytes > 0);
    assert.ok(pod, 'at least one pod should report memory usage');
    assert.equal(pod.namespace, TEST_NAMESPACE);
    assert.ok(pod.cpu_cores >= 0);
    assert.ok(pod.containers.length > 0);
    // Pod totals are the sum of the containers.
    const summed = pod.containers.reduce((s, c) => s + c.memory_bytes, 0);
    assert.equal(pod.memory_bytes, summed);
  });

  test('all-namespaces mode returns pods from more than one namespace', async (t) => {
    if (skipWithoutMetrics(t)) return;
    const result = await dispatch<PodMetricsResult>('get_pod_metrics', {
      namespace: 'All Namespaces',
    });
    assert.equal(result.available, true);
    const namespaces = new Set(result.pods.map((p) => p.namespace));
    assert.ok(namespaces.size > 1, 'expected pods across namespaces');
  });

  test('prometheus is reported as unconfigured when no URL is set', async () => {
    setPrometheusUrl('');
    const result = await dispatch<PrometheusResult>('query_prometheus_range', { query: 'up' });
    assert.equal(result.configured, false);
    assert.deepEqual(result.series, []);
  });

  test(
    'a range query returns samples',
    { skip: !PROMETHEUS_URL ? 'KDASH_PROMETHEUS_URL not set' : false },
    async () => {
      setPrometheusUrl(PROMETHEUS_URL!);
      try {
        const result = await dispatch<PrometheusResult>('query_prometheus_range', {
          query: 'sum(rate(container_cpu_usage_seconds_total{namespace="kdash-test",container!=""}[5m]))',
          minutes: 30,
        });
        assert.equal(result.configured, true);
        assert.ok(result.series.length > 0, 'expected one aggregated series');
        const samples = result.series[0]!.samples;
        assert.ok(samples.length > 1, 'a range query returns a series of points');
        assert.ok(samples.every((s) => Number.isFinite(s.t) && Number.isFinite(s.v)));
      } finally {
        setPrometheusUrl('');
      }
    },
  );

  test(
    'a bad query surfaces the Prometheus error',
    { skip: !PROMETHEUS_URL ? 'KDASH_PROMETHEUS_URL not set' : false },
    async () => {
      setPrometheusUrl(PROMETHEUS_URL!);
      try {
        await assert.rejects(() =>
          dispatch('query_prometheus_range', { query: 'sum(((', minutes: 5 }),
        );
      } finally {
        setPrometheusUrl('');
      }
    },
  );
});
