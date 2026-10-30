// Agent Session lifecycle chain (bun test): a failed stop must not poison
// every later start. The PTY, the MCP endpoint and the kube context lookup
// are stubbed — nothing is spawned, no port is opened, no kubeconfig is read.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HandlerCtx } from '../dispatch';

let spawned = 0;
let failNextMcpStop = false;

function fakePty() {
  return {
    onData: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    write: () => undefined,
    resize: () => undefined,
  };
}

const ctx: HandlerCtx = { emit: () => undefined, mainWindow: () => null };
const deps = { dispatch: async () => null, ctx, requireApproval: () => true };

let workspace: string;
let realMcp: typeof import('./mcp-server');
let realClient: typeof import('../k8s/client');
let session: typeof import('./session');

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kdash-agent-ws-'));
  process.env.KDASH_AGENT_WORKSPACE = workspace;

  // Module mocks are process-wide in bun test: keep the real modules to put
  // back afterwards. node-pty is only imported by session.ts.
  realMcp = { ...(await import('./mcp-server')) };
  realClient = { ...(await import('../k8s/client')) };
  mock.module('node-pty', () => ({
    spawn: () => {
      spawned++;
      return fakePty();
    },
  }));
  mock.module('./mcp-server', () => ({
    ...realMcp,
    startAgentMcpServer: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 't' }),
    stopAgentMcpServer: async () => {
      if (failNextMcpStop) {
        failNextMcpStop = false;
        throw new Error('boom');
      }
    },
  }));
  mock.module('../k8s/client', () => ({
    ...realClient,
    getActiveContextName: () => 'kind-test',
    onConfigChange: () => undefined,
  }));

  session = await import('./session');
});

afterAll(() => {
  mock.module('./mcp-server', () => realMcp);
  mock.module('../k8s/client', () => realClient);
  delete process.env.KDASH_AGENT_WORKSPACE;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('agent session lifecycle', () => {
  test('a stop that throws does not block later starts', async () => {
    const errors = mock(() => undefined);
    const originalError = console.error;
    console.error = errors;
    try {
      await session.startAgentSession({ profileId: 'claude' }, deps);
      expect(spawned).toBe(1);

      failNextMcpStop = true;
      await expect(session.stopAgentSession(ctx)).rejects.toThrow('boom');
      expect(session.agentSessionRunning()).toBe(false);

      await session.startAgentSession({ profileId: 'claude' }, deps);
      expect(spawned).toBe(2);
      expect(session.agentSessionRunning()).toBe(true);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalError;
      await session.stopAllAgentSessions();
    }
  });
});
