// Agent Session lifecycle coverage, driven through the invoke dispatcher with
// the fake Agent Profile (fixtures/fake-agent.sh) — no real CLI, no API keys.
//
// Runs under node:test (not bun) — see setup.ts. Needs the kind cluster only
// because starting a session starts the MCP endpoint, which pins the active
// context.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';

// Must be set BEFORE the fake profile is resolved (any start_agent_session).
// The integration suite always runs from the repo root (npm run test:integration).
const FAKE_BIN = path.resolve('electron/integration/fixtures/fake-agent.sh');
process.env.KDASH_AGENT_FAKE_BIN = FAKE_BIN;
// Keep the suite out of the real agent workspace under $HOME.
process.env.KDASH_AGENT_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'kdash-agent-ws-'));

import { agentSessionRunning } from '../agent/session.js';
import { agentMcpRunning } from '../agent/mcp-server.js';
import { setActiveContext } from '../k8s/client.js';
import { dispatch, emitted, enabled, waitFor, TEST_CONTEXT } from './setup';

/** All agent-output text emitted since the last clear. */
function outputText(): string {
  return emitted
    .filter((e) => e.channel === 'agent-output')
    .map((e) => e.payload as string)
    .join('');
}

function endedEvents(): Array<{ reason: string; code?: number }> {
  return emitted
    .filter((e) => e.channel === 'agent-session-ended')
    .map((e) => e.payload as { reason: string; code?: number });
}

async function startFakeSession(prompt?: string): Promise<{ sessionId: string }> {
  return dispatch<{ sessionId: string }>('start_agent_session', {
    profileId: 'fake',
    ...(prompt !== undefined ? { prompt } : {}),
  });
}

describe('integration: agent session lifecycle', { skip: !enabled }, () => {
  fs.chmodSync(FAKE_BIN, 0o755);

  afterEach(async () => {
    await dispatch('stop_agent_session');
    emitted.length = 0;
  });

  test('start spawns the fake agent with prompt + MCP endpoint wired', async () => {
    const { sessionId } = await startFakeSession('hello world');
    assert.ok(sessionId.length > 0);
    assert.ok(agentSessionRunning());
    assert.ok(agentMcpRunning(), 'MCP endpoint must be alive with the session');

    await waitFor(async () => outputText().includes('ARGS:hello world'), {
      timeoutMs: 10_000,
      intervalMs: 50,
      label: 'fake agent banner',
    });
    const out = outputText();
    assert.match(out, /MCP_URL:http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.match(out, /MCP_TOKEN:[0-9a-f]{64}/);
  });

  test('send_agent_input round-trips and resize does not throw', async () => {
    await startFakeSession();
    await waitFor(async () => outputText().includes('MCP_TOKEN:'), {
      timeoutMs: 10_000,
      intervalMs: 50,
      label: 'fake agent ready',
    });

    await dispatch('send_agent_input', { data: 'ping\r' });
    await waitFor(async () => outputText().includes('ECHO:ping'), {
      timeoutMs: 10_000,
      intervalMs: 50,
      label: 'stdin echo',
    });

    await dispatch('resize_agent_terminal', { cols: 120, rows: 40 });
  });

  test('agent exit ends the session with its exit code and stops the endpoint', async () => {
    await startFakeSession();
    await waitFor(async () => outputText().includes('MCP_TOKEN:'), {
      timeoutMs: 10_000,
      intervalMs: 50,
      label: 'fake agent ready',
    });

    await dispatch('send_agent_input', { data: 'exit\r' });
    await waitFor(async () => endedEvents().some((e) => e.reason === 'exit'), {
      timeoutMs: 10_000,
      intervalMs: 50,
      label: 'agent-session-ended exit',
    });
    const exit = endedEvents().find((e) => e.reason === 'exit');
    assert.equal(exit?.code, 3);
    assert.equal(agentSessionRunning(), false);
    assert.equal(agentMcpRunning(), false);
  });

  test('starting a second session replaces the first', async () => {
    const first = await startFakeSession();
    const second = await startFakeSession();
    assert.notEqual(first.sessionId, second.sessionId);
    assert.ok(endedEvents().some((e) => e.reason === 'replaced'));
    assert.ok(agentSessionRunning());
  });

  test('stop_agent_session kills the process and the endpoint', async () => {
    await startFakeSession();
    await dispatch('stop_agent_session');
    assert.ok(endedEvents().some((e) => e.reason === 'stopped'));
    assert.equal(agentSessionRunning(), false);
    assert.equal(agentMcpRunning(), false);
  });

  test('a kube context switch kills the session', async (t) => {
    const contexts = await dispatch<string[]>('get_contexts');
    const other = contexts.find((c) => c !== TEST_CONTEXT);
    if (!other) return t.skip('kubeconfig has no second context to switch to');

    await startFakeSession();
    try {
      setActiveContext(other);
      await waitFor(async () => endedEvents().some((e) => e.reason === 'context-switch'), {
        timeoutMs: 10_000,
        intervalMs: 50,
        label: 'context-switch teardown',
      });
      assert.equal(agentSessionRunning(), false);
      assert.equal(agentMcpRunning(), false);
    } finally {
      setActiveContext(TEST_CONTEXT as string);
    }
  });
});
