import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { apiserverAgentOptions, kcFor, setKubeconfigPath } from './client';

// kc() itself (the active config) installs an undici dispatcher that Bun's
// undici shim cannot build, so these tests only exercise the PEER path — the
// one compare-across-contexts relies on. The active path is covered by the
// integration suite under Node.

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: alpha
clusters:
  - name: alpha-cluster
    cluster: { server: https://alpha.example:6443, insecure-skip-tls-verify: true }
  - name: beta-cluster
    cluster: { server: https://beta.example:6443, insecure-skip-tls-verify: true }
users:
  - name: alpha-user
    user: { token: a }
  - name: beta-user
    user: { token: b }
contexts:
  - name: alpha
    context: { cluster: alpha-cluster, user: alpha-user }
  - name: beta
    context: { cluster: beta-cluster, user: beta-user, namespace: staging }
`;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdash-client-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, KUBECONFIG);
  setKubeconfigPath(file);
});

afterAll(() => {
  setKubeconfigPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('kcFor', () => {
  test('builds a peer config pinned to the requested context, with its own cluster and user', () => {
    const beta = kcFor('beta');
    expect(beta.getCurrentContext()).toBe('beta');
    expect(beta.getCurrentCluster()?.server).toBe('https://beta.example:6443');
    expect(beta.getCurrentUser()?.token).toBe('b');
    // Cached: the same object comes back.
    expect(kcFor('beta')).toBe(beta);
  });

  test('rejects an unknown context', () => {
    expect(() => kcFor('nope')).toThrow('Context not found: nope');
  });

  test('a kubeconfig change drops the peer cache', () => {
    const before = kcFor('beta');
    setKubeconfigPath(path.join(dir, 'config'));
    const after = kcFor('beta');
    expect(after).not.toBe(before);
    expect(after.getCurrentContext()).toBe('beta');
  });
});

describe('apiserverAgentOptions', () => {
  const connect = { ca: ['x'] };

  test('streams never time out between body chunks (a quiet followed log is not an error)', () => {
    const opts = apiserverAgentOptions(connect, 'stream');
    expect(opts.bodyTimeout).toBe(0);
    expect(opts.connect).toBe(connect);
  });

  test('both modes bound the wait for response headers well under the 300 s undici default', () => {
    for (const mode of ['request', 'stream'] as const) {
      const { headersTimeout } = apiserverAgentOptions(connect, mode);
      expect(headersTimeout).toBeGreaterThan(0);
      expect(headersTimeout!).toBeLessThanOrEqual(60_000);
    }
  });

  test('plain requests keep a finite body timeout', () => {
    const { bodyTimeout } = apiserverAgentOptions(connect, 'request');
    expect(bodyTimeout).toBeGreaterThan(0);
  });
});
