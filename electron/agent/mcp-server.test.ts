// MCP endpoint session bookkeeping (bun test): only `initialize` creates a
// session, unknown ids get 404, and sessions whose client vanished without a
// DELETE are closed once idle. Driven over real loopback HTTP against the
// external endpoint (not pinned to a context, so no kubeconfig is touched).

import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { HandlerCtx } from '../dispatch';
import { externalMcpSessionCount, startExternalMcpServer, stopExternalMcpServer } from './mcp-server';

const TOKEN = 'test-token';
const ctx: HandlerCtx = { emit: () => undefined, mainWindow: () => null };

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

function start(sessionIdleMs?: number): Promise<{ url: string }> {
  return startExternalMcpServer({
    dispatch: async () => null,
    ctx,
    requireApproval: () => true,
    port: 0,
    token: TOKEN,
    ...(sessionIdleMs !== undefined ? { sessionIdleMs } : {}),
  });
}

function post(url: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function initialize(url: string): Promise<string> {
  const res = await post(url, INITIALIZE);
  expect(res.status).toBe(200);
  await res.text();
  const id = res.headers.get('mcp-session-id');
  expect(id).toBeTruthy();
  return id!;
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  await stopExternalMcpServer();
});

describe('session creation', () => {
  test('non-initialize POST without a session is rejected and builds no server', async () => {
    const connect = spyOn(McpServer.prototype, 'connect');
    try {
      const { url } = await start();
      const res = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(400);
      expect(connect).not.toHaveBeenCalled();
      expect(externalMcpSessionCount()).toBe(0);
    } finally {
      connect.mockRestore();
    }
  });

  test('unknown session id gets 404 so the client re-initializes', async () => {
    const connect = spyOn(McpServer.prototype, 'connect');
    try {
      const { url } = await start();
      const res = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'stale-session-id');
      expect(res.status).toBe(404);
      expect(connect).not.toHaveBeenCalled();
      expect(externalMcpSessionCount()).toBe(0);
    } finally {
      connect.mockRestore();
    }
  });

  test('malformed JSON is a 400, not a session', async () => {
    const { url } = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(externalMcpSessionCount()).toBe(0);
  });

  test('initialize creates exactly one session that later requests reach', async () => {
    const { url } = await start();
    const id = await initialize(url);
    expect(externalMcpSessionCount()).toBe(1);

    const res = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('list_resources');
    expect(externalMcpSessionCount()).toBe(1);
  });

  test('a rejected initialize is closed, not leaked', async () => {
    const close = spyOn(McpServer.prototype, 'close');
    try {
      const { url } = await start();
      // Valid initialize, but without the Accept header the SDK requires.
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(406);
      expect(externalMcpSessionCount()).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});

describe('idle expiry', () => {
  test('an idle session is closed and removed after the TTL', async () => {
    const { url } = await start(50);
    const id = await initialize(url);
    expect(externalMcpSessionCount()).toBe(1);

    await until(() => externalMcpSessionCount() === 0);

    const res = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, id);
    expect(res.status).toBe(404);
  });

  test('a session with an open stream is not idle', async () => {
    const { url } = await start(50);
    const id = await initialize(url);

    // Standalone SSE stream: the client is alive even with no new requests.
    const abort = new AbortController();
    const stream = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'mcp-session-id': id },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));
    expect(externalMcpSessionCount()).toBe(1);

    abort.abort();
    await until(() => externalMcpSessionCount() === 0);
  });
});
