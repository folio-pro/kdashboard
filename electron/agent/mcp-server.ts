// Agent MCP endpoint — the cluster-access surface handed to an Agent Session.
//
// See docs/adr/0001-mcp-server-in-main-process.md: the MCP server runs inside
// the Electron main process so the Agent sees exactly the cluster/context the
// UI sees (same KubeConfig, TLS dispatcher and auth caches). It is served as
// streamable HTTP bound to 127.0.0.1 on a random free port, protected by a
// per-session bearer token, and only alive while an Agent Session exists.
//
// Session plumbing follows the SDK's stateful pattern: the first `initialize`
// POST creates an McpServer + transport pair keyed by the SDK session id;
// later requests (POST/GET/DELETE) route to that transport. An agent CLI that
// reconnects mid-session simply initializes a fresh pair.
//
// Two instances can exist:
//   - the SESSION endpoint (random port, per-session token, pinned to the
//     context the session started on) — one per Agent Session;
//   - the EXTERNAL endpoint (fixed port, persisted token, follows the active
//     context) — opt-in from Settings, so Claude Desktop / Cursor / any MCP
//     client can use kdashboard as their Kubernetes MCP server. Mutations
//     still go through the in-app Mutation Approval.

import * as http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getActiveContextName } from '../k8s/client.js';
import type { HandlerCtx } from '../dispatch.js';
import { denyAllPending } from './approval.js';
import { registerAgentTools, type AgentToolDeps, type Dispatch } from './tools.js';

export interface McpEndpoint {
  url: string;
  token: string;
}

export interface AgentMcpOptions {
  dispatch: Dispatch;
  ctx: HandlerCtx;
  /** Mutation Approval toggle (settings-backed in the app, injectable in tests). */
  requireApproval: () => boolean;
}

interface McpInstance {
  httpServer: http.Server;
  url: string;
  token: string;
  transports: Map<string, StreamableHTTPServerTransport>;
  servers: Map<string, McpServer>;
}

interface CreateOptions extends AgentMcpOptions {
  token: string;
  /** 0 = any free port. */
  port: number;
  pinnedContext: string | undefined | null;
}

let instance: McpInstance | null = null;
let external: McpInstance | null = null;

/** True while the SESSION endpoint is listening (i.e. an Agent Session is alive). */
export function agentMcpRunning(): boolean {
  return instance !== null;
}

/**
 * Start the session endpoint (single slot — a running instance is stopped
 * first). `dispatch` is the same command dispatcher the renderer drives, so
 * tools and UI share one behavior; `ctx` reaches the renderer for approval
 * requests.
 */
export async function startAgentMcpServer(options: AgentMcpOptions): Promise<McpEndpoint> {
  await stopAgentMcpServer();
  instance = await createInstance({
    ...options,
    token: randomBytes(32).toString('hex'),
    port: 0,
    // Pinned at session start: tools fail closed if the UI switches context.
    pinnedContext: getActiveContextName(),
  });
  return { url: instance.url, token: instance.token };
}

/** Stop the session endpoint and drop every live MCP session. Safe to call when idle. */
export async function stopAgentMcpServer(): Promise<void> {
  const current = instance;
  if (!current) return;
  instance = null;
  // A dead endpoint can never deliver an approval answer — deny, don't hang.
  denyAllPending();
  await closeInstance(current);
}

export interface ExternalMcpOptions extends AgentMcpOptions {
  port: number;
  token: string;
}

/**
 * Start (or restart with new settings) the external endpoint. Not pinned to
 * a context: external clients see whatever the UI has active, exactly like a
 * Quick Action would. Throws when the port is taken.
 */
export async function startExternalMcpServer(options: ExternalMcpOptions): Promise<McpEndpoint> {
  await stopExternalMcpServer();
  external = await createInstance({ ...options, pinnedContext: null });
  return { url: external.url, token: external.token };
}

export async function stopExternalMcpServer(): Promise<void> {
  const current = external;
  if (!current) return;
  external = null;
  await closeInstance(current);
}

export function externalMcpEndpoint(): McpEndpoint | null {
  return external ? { url: external.url, token: external.token } : null;
}

async function createInstance(options: CreateOptions): Promise<McpInstance> {
  const { token, port } = options;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const deps: AgentToolDeps = {
    dispatch: options.dispatch,
    ctx: options.ctx,
    requireApproval: options.requireApproval,
    pinnedContext: options.pinnedContext,
  };

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid bearer token' }));
      return;
    }

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or missing mcp-session-id' }));
      return;
    }

    // New session: build a server+transport pair and let the SDK take over.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
        servers.set(id, mcpServer);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        transports.delete(id);
        const server = servers.get(id);
        servers.delete(id);
        void server?.close();
      }
    };
    const mcpServer = new McpServer({ name: 'kdashboard', version: '1.0.0' });
    registerAgentTools(mcpServer, deps);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    httpServer.close();
    throw new Error('agent MCP server failed to bind a port');
  }

  return {
    httpServer,
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    transports,
    servers,
  };
}

async function closeInstance(current: McpInstance): Promise<void> {
  for (const transport of current.transports.values()) {
    try {
      await transport.close();
    } catch {
      // closing must never fail the caller
    }
  }
  current.transports.clear();
  for (const server of current.servers.values()) {
    try {
      await server.close();
    } catch {
      // ignore
    }
  }
  current.servers.clear();

  await new Promise<void>((resolve) => {
    current.httpServer.close(() => resolve());
    // close() waits for idle keep-alive sockets; cut them loose instead.
    current.httpServer.closeAllConnections?.();
  });
}
