import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KubeConfig, RequestContext } from '@kubernetes/client-node';

import { CachedClusterAuth } from './client';

// A local HTTPS server whose responses take `delay` ms, standing in for a slow
// cluster-wide LIST that straddles an auth-cache refresh.

let dir: string;
let server: https.Server;
let port: number;
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

beforeAll(async () => {
  if (!hasOpenssl) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdash-auth-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert,
  ]);
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const delay = Number(new URL(req.url ?? '/', 'https://x').searchParams.get('delay') ?? 0);
    setTimeout(() => res.end('ok'), delay);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Fake KubeConfig: a fresh token + a brand-new https.Agent per call, like client-node. */
function fakeConfig(tls: { servername?: string }) {
  let n = 0;
  return {
    applySecurityAuthentication: async (ctx: RequestContext) => {
      n += 1;
      ctx.setHeaderParam('Authorization', `Bearer t${n}`);
      ctx.setAgent(new https.Agent({ rejectUnauthorized: false, servername: tls.servername }));
    },
  } as unknown as KubeConfig;
}

function get(agent: unknown, delay: number): Promise<string> {
  return new Promise((resolve) => {
    const req = https.get(
      { host: '127.0.0.1', port, path: `/?delay=${delay}`, agent: agent as https.Agent, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', (e) => resolve(`error: ${e.message}`));
      },
    );
    req.on('error', (e) => resolve(`error: ${e.message}`));
  });
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasOpenssl)('CachedClusterAuth refresh', () => {
  test('reuses the agent (warm pool) when only the token changed', async () => {
    const auth = new CachedClusterAuth(fakeConfig({}));
    const first = await auth.getAuth();
    auth.expire();
    const second = await auth.getAuth();
    expect(second.headers.Authorization).not.toBe(first.headers.Authorization);
    expect(second.agent).toBe(first.agent);
    auth.destroy();
  });

  test('an in-flight request survives a refresh that rotates the agent', async () => {
    const tls = { servername: 'a' };
    const auth = new CachedClusterAuth(fakeConfig(tls));
    const first = await auth.getAuth();
    const inflight = get(first.agent, 300);
    await tick(50);

    tls.servername = 'b'; // TLS material changed: a new agent is required
    auth.expire();
    const second = await auth.getAuth();
    expect(second.agent).not.toBe(first.agent);

    expect(await inflight).toBe('ok');
    // The retired agent does not pool the released socket.
    await tick(20);
    expect(Object.values((first.agent as https.Agent).freeSockets).flat().length).toBe(0);
    auth.destroy();
  });

  test('destroy() (context switch) still tears down in-flight requests', async () => {
    const auth = new CachedClusterAuth(fakeConfig({}));
    const { agent } = await auth.getAuth();
    const inflight = get(agent, 300);
    await tick(50);
    auth.destroy();
    expect(await inflight).toStartWith('error');
  });
});
