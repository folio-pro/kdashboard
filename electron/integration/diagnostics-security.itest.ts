// diagnose_resource against live objects, and get_security_overview /
// scan_image graceful degradation when no scanner is installed.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ResourceList } from '../k8s/resource-types';
import type { DiagnosticResult } from '../handlers/topology/diagnostics';
import { dispatch, enabled, TEST_NAMESPACE } from './setup';

const HEALTHS = ['healthy', 'degraded', 'unhealthy'];
const SEVERITIES = ['critical', 'warning', 'info'];

describe('integration: diagnostics', { skip: !enabled }, () => {
  test('diagnose a running pod yields a valid result', { timeout: 60_000 }, async () => {
    const pods = await dispatch<ResourceList>('list_pods_by_selector', {
      namespace: TEST_NAMESPACE,
      selector: 'app=test-nginx',
    });
    assert.ok(pods.items.length > 0);

    const result = await dispatch<DiagnosticResult>('diagnose_resource', {
      kind: 'Pod',
      name: pods.items[0]!.metadata.name,
      namespace: TEST_NAMESPACE,
    });
    assert.equal(result.resource_kind, 'Pod');
    assert.ok(HEALTHS.includes(result.health));
    assert.ok(result.resource_uid);
    assert.ok(result.checked_at);
    for (const issue of result.issues) {
      assert.ok(SEVERITIES.includes(issue.severity));
      assert.ok(issue.title);
      assert.ok(issue.suggestion);
    }
  });

  test('diagnose the deployment', { timeout: 60_000 }, async () => {
    const result = await dispatch<DiagnosticResult>('diagnose_resource', {
      kind: 'Deployment',
      name: 'test-nginx',
      namespace: TEST_NAMESPACE,
    });
    assert.equal(result.resource_kind, 'Deployment');
    assert.equal(result.resource_name, 'test-nginx');
    assert.ok(HEALTHS.includes(result.health));
  });

  test('diagnose a kind without a dedicated analyzer falls through cleanly', { timeout: 60_000 }, async () => {
    const result = await dispatch<DiagnosticResult>('diagnose_resource', {
      kind: 'Job',
      name: 'test-job',
      namespace: TEST_NAMESPACE,
    });
    assert.equal(result.resource_kind, 'Job');
    assert.ok(HEALTHS.includes(result.health));
  });

  test('diagnose a nonexistent resource rejects', async () => {
    await assert.rejects(
      dispatch('diagnose_resource', {
        kind: 'Pod',
        name: 'does-not-exist',
        namespace: TEST_NAMESPACE,
      }),
    );
  });

  test('diagnose an invalid kind rejects', async () => {
    await assert.rejects(
      dispatch('diagnose_resource', {
        kind: 'Flurble',
        name: 'whatever',
        namespace: TEST_NAMESPACE,
      }),
    );
  });
});

describe('integration: security (no scanner installed)', { skip: !enabled }, () => {
  test('get_security_overview degrades gracefully for the namespace', { timeout: 120_000 }, async () => {
    const overview = await dispatch<Record<string, unknown>>('get_security_overview', {
      namespace: TEST_NAMESPACE,
    });
    assert.ok(overview);
    assert.equal(typeof overview, 'object');
  });

  test('get_security_overview works cluster-wide', { timeout: 120_000 }, async () => {
    const overview = await dispatch<Record<string, unknown>>('get_security_overview', {
      namespace: null,
    });
    assert.ok(overview);
  });

  test('scan_image without trivy/grype reports unavailable instead of hanging', { timeout: 120_000 }, async () => {
    try {
      const result = await dispatch<Record<string, unknown>>('scan_image', {
        image: 'nginx:1.27-alpine',
      });
      assert.ok(result);
    } catch (err) {
      // No scanner on the runner — an explanatory error is the expected shape.
      assert.ok(err instanceof Error);
    }
  });
});
