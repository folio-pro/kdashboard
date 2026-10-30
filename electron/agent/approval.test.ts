// Mutation Approval broker: pending approvals are scoped to the endpoint that
// asked, so stopping the Agent Session's endpoint can't deny a request an
// external MCP client is still waiting on.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import type { HandlerCtx } from '../dispatch';
import {
  denyAllPending,
  denyPending,
  pendingApprovalCount,
  requestApproval,
  respondApproval,
  type ApprovalSummary,
} from './approval';

const summary: ApprovalSummary = {
  tool: 'scale_workload',
  context: 'kind-test',
  resource: { kind: 'Deployment', namespace: 'default', name: 'web' },
  changes: ['replicas: 1 → 2'],
};

function recordingCtx(): HandlerCtx & { ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    emit(_channel, payload) {
      ids.push((payload as { id: string }).id);
    },
    mainWindow: () => null,
  };
}

/** Settled value of `p`, or 'pending' if it hasn't settled yet. */
async function state(p: Promise<boolean>): Promise<boolean | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 10))]);
}

describe('denyPending', () => {
  test('denies only the given origin', async () => {
    const ctx = recordingCtx();
    const fromSession = requestApproval(summary, ctx, 'session');
    const fromExternal = requestApproval(summary, ctx, 'external');

    denyPending('session');

    expect(await state(fromSession)).toBe(false);
    expect(await state(fromExternal)).toBe('pending');
    expect(pendingApprovalCount()).toBe(1);

    respondApproval(ctx.ids[1]!, true);
    expect(await fromExternal).toBe(true);
    expect(pendingApprovalCount()).toBe(0);
  });

  test('denyAllPending (renderer death) still denies every origin', async () => {
    const ctx = recordingCtx();
    const a = requestApproval(summary, ctx, 'session');
    const b = requestApproval(summary, ctx, 'external');

    denyAllPending();

    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(pendingApprovalCount()).toBe(0);
  });
});

describe('stopAgentMcpServer', () => {
  // The session endpoint pins the active context at start. Stub only that
  // lookup (kc() installs an undici dispatcher Bun can't build) and put the
  // real module back afterwards — module mocks are process-wide in bun test.
  let real: typeof import('../k8s/client');

  beforeAll(async () => {
    real = { ...(await import('../k8s/client')) };
    mock.module('../k8s/client', () => ({ ...real, getActiveContextName: () => 'kind-test' }));
  });

  afterAll(() => {
    mock.module('../k8s/client', () => real);
  });

  test('denies the session endpoint approvals, keeps external ones pending', async () => {
    const { startAgentMcpServer, stopAgentMcpServer } = await import('./mcp-server');
    const ctx = recordingCtx();
    await startAgentMcpServer({ dispatch: async () => null, ctx, requireApproval: () => true });

    const fromSession = requestApproval(summary, ctx, 'session');
    const fromExternal = requestApproval(summary, ctx, 'external');

    await stopAgentMcpServer();

    expect(await state(fromSession)).toBe(false);
    expect(await state(fromExternal)).toBe('pending');

    denyAllPending();
    expect(await fromExternal).toBe(false);
  });
});
