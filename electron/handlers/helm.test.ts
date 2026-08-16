import { test, expect, describe } from 'bun:test';
import { gzipSync } from 'node:zlib';

import { decodeRelease, latestPerRelease, releaseSummary } from './helm';

const RELEASE = {
  name: 'ingress-nginx',
  namespace: 'ingress',
  version: 7,
  info: {
    status: 'deployed',
    description: 'Upgrade complete',
    last_deployed: '2026-07-01T10:00:00Z',
    notes: 'The ingress controller has been installed.',
  },
  chart: {
    metadata: { name: 'ingress-nginx', version: '4.11.2', appVersion: '1.11.2' },
    values: { controller: { replicaCount: 1 } },
  },
  config: { controller: { replicaCount: 3 } },
  manifest: 'apiVersion: v1\nkind: Service\n',
};

/** How helm + the Kubernetes API actually encode a release Secret value. */
function encodeAsSecretData(obj: unknown): string {
  const gzipped = gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
  const helmLayer = gzipped.toString('base64');
  return Buffer.from(helmLayer, 'utf8').toString('base64');
}

describe('decodeRelease', () => {
  test('unwraps base64 -> base64 -> gzip -> JSON', async () => {
    expect(await decodeRelease(encodeAsSecretData(RELEASE))).toEqual(RELEASE);
  });

  test('accepts a payload with only helm\'s gzip layer (no second base64)', async () => {
    const singleLayer = gzipSync(Buffer.from(JSON.stringify(RELEASE), 'utf8')).toString('base64');
    expect(await decodeRelease(singleLayer)).toEqual(RELEASE);
  });

  test('accepts an uncompressed JSON payload', async () => {
    const plain = Buffer.from(
      Buffer.from(JSON.stringify(RELEASE), 'utf8').toString('base64'),
      'utf8',
    ).toString('base64');
    expect(await decodeRelease(plain)).toEqual(RELEASE);
  });

  test('throws on a payload that is not a release object', async () => {
    const notAnObject = Buffer.from(
      Buffer.from('"just a string"', 'utf8').toString('base64'),
      'utf8',
    ).toString('base64');
    await expect(decodeRelease(notAnObject)).rejects.toThrow('not a JSON object');
  });
});

describe('releaseSummary', () => {
  test('flattens the fields the list needs', () => {
    expect(releaseSummary(RELEASE)).toEqual({
      name: 'ingress-nginx',
      namespace: 'ingress',
      revision: 7,
      status: 'deployed',
      chart: 'ingress-nginx',
      chart_version: '4.11.2',
      app_version: '1.11.2',
      updated: '2026-07-01T10:00:00Z',
      description: 'Upgrade complete',
    });
  });

  test('a release with no chart metadata degrades to empty strings', () => {
    const summary = releaseSummary({ name: 'x', namespace: 'y', version: 1 });
    expect(summary.chart).toBe('');
    expect(summary.status).toBe('unknown');
  });
});

describe('latestPerRelease', () => {
  const secret = (release: string, namespace: string, revision: number) => ({
    name: `sh.helm.release.v1.${release}.v${revision}`,
    namespace,
    release,
    revision,
  });

  test('keeps the highest revision per release', () => {
    const latest = latestPerRelease([
      secret('web', 'prod', 1),
      secret('web', 'prod', 3),
      secret('web', 'prod', 2),
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.revision).toBe(3);
  });

  test('same release name in two namespaces stays two releases', () => {
    const latest = latestPerRelease([secret('web', 'prod', 2), secret('web', 'staging', 1)]);
    expect(latest.map((s) => s.namespace).sort()).toEqual(['prod', 'staging']);
  });
});
