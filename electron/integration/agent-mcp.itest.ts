// Agent MCP endpoint coverage: a real MCP client over streamable HTTP against
// the in-process server, driving read tools and Safe Mutations (with the
// Mutation Approval gate) against the kind cluster.
//
// Runs under node:test (not bun) — see setup.ts. The context-switch guard is
// exercised with a real setActiveContext() to another context from the local
// kubeconfig (context validation is name-only, so the other cluster does not
// need to be reachable).

import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startAgentMcpServer, stopAgentMcpServer, agentMcpRunning } from '../agent/mcp-server.js';
import { setActiveContext } from '../k8s/client.js';
import { dispatch, emitted, enabled, waitFor, TEST_CONTEXT, TEST_NAMESPACE } from './setup';
import type { HandlerCtx } from '../dispatch.js';

const ctx: HandlerCtx = {
  emit(channel, payload) {
    emitted.push({ channel, payload });
  },
  mainWindow: () => null,
};

/** Toggled per test — stands in for the settings-backed provider. */
let requireApproval = true;

interface TextResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function resultText(result: unknown): string {
  return (result as TextResult).content.map((c) => c.text).join('\n');
}

async function startServer(): Promise<{ url: string; token: string }> {
  return startAgentMcpServer({
    dispatch: (cmd, args) => dispatch(cmd, args),
    ctx,
    requireApproval: () => requireApproval,
  });
}

async function connectClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'itest-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** One connected client per test, torn down in afterEach. */
let client: Client | null = null;

async function freshClient(): Promise<Client> {
  await dispatch('get_current_context'); // primes the dispatcher + context
  const endpoint = await startServer();
  client = await connectClient(endpoint.url, endpoint.token);
  return client;
}

/** Wait for the next agent-approval-request and answer it. */
async function answerNextApproval(approved: boolean): Promise<void> {
  const seen = emitted.length;
  const event = await waitFor(
    async () => emitted.slice(seen).find((e) => e.channel === 'agent-approval-request'),
    { timeoutMs: 15_000, intervalMs: 50, label: 'agent-approval-request event' },
  );
  const { id } = event.payload as { id: string };
  await dispatch('respond_agent_approval', { id, approved });
}

describe('integration: agent MCP endpoint', { skip: !enabled }, () => {
  afterEach(async () => {
    emitted.length = 0;
    requireApproval = true;
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    await stopAgentMcpServer();
  });
  after(async () => {
    await stopAgentMcpServer();
  });

  // -------------------------------------------------------------------------
  // Endpoint + auth
  // -------------------------------------------------------------------------

  test('serves get_current_context to an authorized MCP client', async () => {
    const c = await freshClient();
    assert.ok(agentMcpRunning());

    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      'get_current_context',
      'list_resources',
      'get_resource',
      'get_pod_logs',
      'list_events',
      'top_pods',
      'top_nodes',
      'scale_workload',
      'restart_rollout',
      'delete_pod',
      'update_container_resources',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected} in: ${names.join(', ')}`);
    }

    const result = await c.callTool({ name: 'get_current_context', arguments: {} });
    const parsed = JSON.parse(resultText(result)) as { context: string; namespaces: string[] };
    assert.equal(parsed.context, TEST_CONTEXT);
    assert.ok(parsed.namespaces.includes(TEST_NAMESPACE));
  });

  test('rejects a client without or with a wrong bearer token', async () => {
    await dispatch('get_current_context');
    const endpoint = await startServer();

    const anon = new Client({ name: 'itest-anon', version: '0.0.0' });
    await assert.rejects(anon.connect(new StreamableHTTPClientTransport(new URL(endpoint.url))));
    await assert.rejects(connectClient(endpoint.url, 'not-the-token'));
  });

  test('stopAgentMcpServer closes the port', async () => {
    await dispatch('get_current_context');
    const endpoint = await startServer();
    await stopAgentMcpServer();
    assert.equal(agentMcpRunning(), false);
    await assert.rejects(connectClient(endpoint.url, endpoint.token));
  });

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------

  test('list_resources returns the fixture pods', async () => {
    const c = await freshClient();
    const result = await c.callTool({
      name: 'list_resources',
      arguments: { resourceType: 'pods', namespace: TEST_NAMESPACE },
    });
    const parsed = JSON.parse(resultText(result)) as { items: Array<{ metadata: { name: string } }> };
    assert.ok(parsed.items.length > 0);
    assert.ok(parsed.items.some((i) => i.metadata.name.startsWith('test-nginx')));
  });

  test('get_resource returns YAML without managedFields', async () => {
    const c = await freshClient();
    const result = await c.callTool({
      name: 'get_resource',
      arguments: { kind: 'Deployment', name: 'test-nginx', namespace: TEST_NAMESPACE },
    });
    const yaml = resultText(result);
    assert.match(yaml, /kind: Deployment/);
    assert.match(yaml, /name: test-nginx/);
    assert.ok(!yaml.includes('managedFields'));
  });

  test('get_pod_logs reads logs from a fixture pod', async () => {
    const c = await freshClient();
    const pods = JSON.parse(
      resultText(
        await c.callTool({
          name: 'list_resources',
          arguments: { resourceType: 'pods', namespace: TEST_NAMESPACE },
        }),
      ),
    ) as { items: Array<{ metadata: { name: string } }> };
    const pod = pods.items.find((i) => i.metadata.name.startsWith('test-nginx'));
    assert.ok(pod, 'fixture pod test-nginx-* not found');

    const result = (await c.callTool({
      name: 'get_pod_logs',
      arguments: { namespace: TEST_NAMESPACE, pod: pod.metadata.name, tailLines: 50 },
    })) as TextResult;
    assert.notEqual(result.isError, true, resultText(result));
    assert.equal(typeof resultText(result), 'string');
  });

  test('list_events returns namespace events', async () => {
    const c = await freshClient();
    const result = (await c.callTool({
      name: 'list_events',
      arguments: { namespace: TEST_NAMESPACE },
    })) as TextResult;
    assert.notEqual(result.isError, true, resultText(result));
    assert.ok(Array.isArray(JSON.parse(resultText(result))));
  });

  test('top_pods returns metrics or a structured message', async () => {
    const c = await freshClient();
    const result = (await c.callTool({
      name: 'top_pods',
      arguments: { namespace: TEST_NAMESPACE },
    })) as TextResult;
    // Without metrics-server this is an isError text result — still structured,
    // never a protocol failure.
    assert.equal(typeof resultText(result), 'string');
    assert.ok(resultText(result).length > 0);
  });

  // -------------------------------------------------------------------------
  // Safe Mutations + Mutation Approval
  // -------------------------------------------------------------------------

  test('scale_workload waits for approval, then scales', async () => {
    const c = await freshClient();

    const pending = c.callTool({
      name: 'scale_workload',
      arguments: { kind: 'Deployment', namespace: TEST_NAMESPACE, name: 'test-nginx', replicas: 2 },
    });
    await answerNextApproval(true);
    const result = (await pending) as TextResult;
    assert.notEqual(result.isError, true, resultText(result));
    assert.match(resultText(result), /Done: scale_workload/);

    const yaml = resultText(
      await c.callTool({
        name: 'get_resource',
        arguments: { kind: 'Deployment', name: 'test-nginx', namespace: TEST_NAMESPACE },
      }),
    );
    assert.match(yaml, /replicas: 2/);

    // Restore the fixture's replica count.
    const restore = c.callTool({
      name: 'scale_workload',
      arguments: { kind: 'Deployment', namespace: TEST_NAMESPACE, name: 'test-nginx', replicas: 1 },
    });
    await answerNextApproval(true);
    await restore;
  });

  test('a denied mutation leaves the cluster untouched and reads as a denial', async () => {
    const c = await freshClient();
    const before = resultText(
      await c.callTool({
        name: 'get_resource',
        arguments: { kind: 'Deployment', name: 'test-nginx', namespace: TEST_NAMESPACE },
      }),
    );

    const pending = c.callTool({
      name: 'scale_workload',
      arguments: { kind: 'Deployment', namespace: TEST_NAMESPACE, name: 'test-nginx', replicas: 5 },
    });
    await answerNextApproval(false);
    const result = (await pending) as TextResult;
    assert.notEqual(result.isError, true, 'denial must be a normal result, not an error');
    assert.match(resultText(result), /DENIED/);

    const after_ = resultText(
      await c.callTool({
        name: 'get_resource',
        arguments: { kind: 'Deployment', name: 'test-nginx', namespace: TEST_NAMESPACE },
      }),
    );
    const replicasOf = (yaml: string): string => /replicas: \d+/.exec(yaml)?.[0] ?? '';
    assert.equal(replicasOf(after_), replicasOf(before));
  });

  test('with approval disabled, mutations run without an approval event', async () => {
    requireApproval = false;
    const c = await freshClient();

    const result = (await c.callTool({
      name: 'restart_rollout',
      arguments: { kind: 'Deployment', namespace: TEST_NAMESPACE, name: 'test-nginx' },
    })) as TextResult;
    assert.notEqual(result.isError, true, resultText(result));
    assert.equal(
      emitted.filter((e) => e.channel === 'agent-approval-request').length,
      0,
      'no approval event expected',
    );
  });

  test('update_container_resources patches requests/limits', async () => {
    requireApproval = false;
    const c = await freshClient();

    const result = (await c.callTool({
      name: 'update_container_resources',
      arguments: {
        kind: 'Deployment',
        namespace: TEST_NAMESPACE,
        name: 'test-nginx',
        container: 'nginx',
        requests: { cpu: '15m', memory: '48Mi' },
      },
    })) as TextResult;
    assert.notEqual(result.isError, true, resultText(result));

    const yaml = resultText(
      await c.callTool({
        name: 'get_resource',
        arguments: { kind: 'Deployment', name: 'test-nginx', namespace: TEST_NAMESPACE },
      }),
    );
    assert.match(yaml, /cpu: 15m/);
    assert.match(yaml, /memory: 48Mi/);
  });

  test('delete_pod deletes one pod end-to-end', async () => {
    requireApproval = false;
    const c = await freshClient();

    const listPods = async (): Promise<string[]> =>
      (
        JSON.parse(
          resultText(
            await c.callTool({
              name: 'list_resources',
              arguments: { resourceType: 'pods', namespace: TEST_NAMESPACE },
            }),
          ),
        ) as { items: Array<{ metadata: { name: string } }> }
      ).items
        .map((i) => i.metadata.name)
        .filter((n) => n.startsWith('test-nginx'));

    const [victim] = await listPods();
    assert.ok(victim, 'no test-nginx pod to delete');

    const result = (await c.callTool({
      name: 'delete_pod',
      arguments: { namespace: TEST_NAMESPACE, name: victim },
    })) as TextResult;
    assert.notEqual(result.isError, true, resultText(result));

    // The deployment recreates it; the deleted name must eventually disappear.
    await waitFor(async () => !(await listPods()).includes(victim), {
      timeoutMs: 60_000,
      label: 'deleted pod to disappear',
    });
  });

  // -------------------------------------------------------------------------
  // Context pinning
  // -------------------------------------------------------------------------

  test('tools fail closed after a kube context switch', async (t) => {
    const contexts = await dispatch<string[]>('get_contexts');
    const other = contexts.find((c) => c !== TEST_CONTEXT);
    if (!other) return t.skip('kubeconfig has no second context to switch to');

    const c = await freshClient();
    try {
      setActiveContext(other);
      const result = (await c.callTool({
        name: 'get_current_context',
        arguments: {},
      })) as TextResult;
      assert.equal(result.isError, true);
      assert.match(resultText(result), /context changed/i);

      const mutation = (await c.callTool({
        name: 'scale_workload',
        arguments: { kind: 'Deployment', namespace: TEST_NAMESPACE, name: 'test-nginx', replicas: 3 },
      })) as TextResult;
      assert.equal(mutation.isError, true);
      assert.equal(
        emitted.filter((e) => e.channel === 'agent-approval-request').length,
        0,
        'guard must fire before the approval gate',
      );
    } finally {
      setActiveContext(TEST_CONTEXT as string);
    }
  });
});
