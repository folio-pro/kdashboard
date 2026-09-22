// Agent MCP endpoint — the cluster-access surface handed to an Agent Session.
//
// See docs/adr/0001-mcp-server-in-main-process.md: the MCP server runs inside
// the Electron main process so the Agent sees exactly the cluster/context the
// UI sees (same KubeConfig, TLS dispatcher and auth caches). It is served as
// streamable HTTP bound to 127.0.0.1 on a random free port, protected by a
// per-session bearer token, and only alive while an Agent Session exists.
//
// Session plumbing follows the SDK's stateful pattern: an `initialize` POST
// (and nothing else) creates an McpServer + transport pair keyed by the SDK
// session id; later requests (POST/GET/DELETE) route to that transport. An
// unknown session id gets 404 so the client re-initializes. Clients that
// vanish without a DELETE (killed, restarted) would leave their pair behind
// forever, so sessions with no open request for SESSION_IDLE_MS are closed.
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
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { getActiveContextName } from '../k8s/client.js';
import type { HandlerCtx } from '../dispatch.js';
import { denyAllPending } from './approval.js';
import { contextGuardMessage, registerAgentTools, type AgentToolDeps, type Dispatch } from './tools.js';

/** Close a session after this long with no request in flight. */
const SESSION_IDLE_MS = 30 * 60_000;
/** Same cap the SDK applies when it reads the body itself. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpEndpoint {
  url: string;
  token: string;
}

export interface AgentMcpOptions {
  dispatch: Dispatch;
  ctx: HandlerCtx;
  /** Mutation Approval toggle (settings-backed in the app, injectable in tests). */
  requireApproval: () => boolean;
  /** Idle session TTL; defaults to SESSION_IDLE_MS (injectable in tests). */
  sessionIdleMs?: number;
}

interface ListenOptions extends AgentMcpOptions {
  token: string;
  /** 0 = any free port. */
  port: number;
  /** See AgentToolDeps.refusal. */
  refusal: () => string | null;
}

interface McpInstance {
  httpServer: http.Server;
  url: string;
  token: string;
  transports: Map<string, StreamableHTTPServerTransport>;
  servers: Map<string, McpServer>;
  sweeper: ReturnType<typeof setInterval>;
}

/** One endpoint slot: at most one listener, restarted on start(). */
class EndpointSlot {
  private instance: McpInstance | null = null;

  get endpoint(): McpEndpoint | null {
    return this.instance ? { url: this.instance.url, token: this.instance.token } : null;
  }

  get sessionCount(): number {
    return this.instance?.transports.size ?? 0;
  }

  async start(options: ListenOptions): Promise<McpEndpoint> {
    await this.stop();
    this.instance = await listen(options);
    return this.endpoint!;
  }

  async stop(): Promise<void> {
    const current = this.instance;
    if (!current) return;
    this.instance = null;
    await closeInstance(current);
  }
}

const session = new EndpointSlot();
const external = new EndpointSlot();

/** True while the SESSION endpoint is listening (i.e. an Agent Session is alive). */
export function agentMcpRunning(): boolean {
  return session.endpoint !== null;
}

/**
 * Start the session endpoint (a running one is stopped first). `dispatch` is
 * the same command dispatcher the renderer drives, so tools and UI share one
 * behavior; `ctx` reaches the renderer for approval requests. Pinned at start:
 * tools fail closed if the UI switches context.
 */
export function startAgentMcpServer(options: AgentMcpOptions): Promise<McpEndpoint> {
  const pinned = getActiveContextName();
  return session.start({
    ...options,
    token: randomBytes(32).toString('hex'),
    port: 0,
    refusal: () => contextGuardMessage(pinned, getActiveContextName()),
  });
}

/** Stop the session endpoint and drop every live MCP session. Safe to call when idle. */
export async function stopAgentMcpServer(): Promise<void> {
  // A dead endpoint can never deliver an approval answer — deny, don't hang.
  if (session.endpoint) denyAllPending();
  await session.stop();
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
export function startExternalMcpServer(options: ExternalMcpOptions): Promise<McpEndpoint> {
  return external.start({ ...options, refusal: () => null });
}

export function stopExternalMcpServer(): Promise<void> {
  return external.stop();
}

export function externalMcpEndpoint(): McpEndpoint | null {
  return external.endpoint;
}

/** Live MCP sessions on the external endpoint (tests). */
export function externalMcpSessionCount(): number {
  return external.sessionCount;
}

async function listen(options: ListenOptions): Promise<McpInstance> {
  const { token, port } = options;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  /** Per session: when its last request ended, and how many are still open (SSE streams). */
  const activity = new Map<string, { lastSeen: number; open: number }>();
  const idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;

  const deps: AgentToolDeps = {
    dispatch: options.dispatch,
    ctx: options.ctx,
    requireApproval: options.requireApproval,
    refusal: options.refusal,
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
      track(sessionId, res);
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }
    if (typeof sessionId === 'string') {
      // Expired, closed, or from before an app restart: spec says 404 → re-initialize.
      rpcError(res, 404, -32001, 'Session not found');
      return;
    }
    if (req.method !== 'POST') {
      rpcError(res, 400, -32000, 'Bad Request: missing mcp-session-id');
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof BodyTooLarge) rpcError(res, 413, -32000, 'Payload too large');
      else rpcError(res, 400, -32700, 'Parse error');
      return;
    }
    if (!isInitializeRequest(body)) {
      rpcError(res, 400, -32000, 'Bad Request: no session; send initialize first');
      return;
    }

    // New session: build a server+transport pair and let the SDK take over.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
        servers.set(id, mcpServer);
        track(id, res);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        activity.delete(id);
        transports.delete(id);
        const server = servers.get(id);
        servers.delete(id);
        void server?.close();
      }
    };
    const mcpServer = new McpServer({ name: 'kdashboard', version: '1.0.0' });
    registerAgentTools(mcpServer, deps);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    if (!transport.sessionId) {
      // The SDK rejected the initialize: the pair was never registered, drop it.
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    }
  }

  /** Mark a request on `id` as open until its response closes. */
  function track(id: string, res: http.ServerResponse): void {
    const entry = activity.get(id) ?? { lastSeen: Date.now(), open: 0 };
    activity.set(id, entry);
    entry.open++;
    res.once('close', () => {
      entry.open--;
      entry.lastSeen = Date.now();
    });
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

  // Close sessions whose client went away without a DELETE. onclose removes
  // them from the maps.
  const sweeper = setInterval(
    () => {
      const now = Date.now();
      for (const [id, entry] of activity) {
        if (entry.open > 0 || now - entry.lastSeen < idleMs) continue;
        activity.delete(id);
        void transports.get(id)?.close().catch(() => undefined);
      }
    },
    Math.min(60_000, idleMs),
  );
  sweeper.unref();

  return {
    httpServer,
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    transports,
    servers,
    sweeper,
  };
}

class BodyTooLarge extends Error {}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON-RPC error response, shaped like the SDK's own. */
function rpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function closeInstance(current: McpInstance): Promise<void> {
  clearInterval(current.sweeper);
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
