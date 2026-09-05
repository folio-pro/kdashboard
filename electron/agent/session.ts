// Agent Session manager — the dedicated local-PTY slot for the embedded AI
// agent. Deliberately separate from handlers/terminal.ts (remote k8s exec):
// different transport, different lifecycle; the exec single-slot rule stays
// untouched and the two terminals coexist.
//
// One Agent Session at a time. Starting a new one replaces the old. The
// session owns the MCP endpoint: it starts it, hands it to the agent CLI, and
// stops it on every exit path. The session is pinned to the kube context it
// started on — any kubeconfig/context change kills it with a notice.
//
// Event channels (renderer consumer: src/lib/components/agent/AgentPanel.svelte):
//   - agent-output        : string  (coalesced PTY chunk)
//   - agent-session-ended : { reason: 'exit'|'stopped'|'replaced'|'context-switch', code?: number }

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as pty from 'node-pty';

import type { HandlerCtx } from '../dispatch.js';
import { getActiveContextName, onConfigChange } from '../k8s/client.js';
import { makeOutputCoalescer, type OutputCoalescer } from '../util/output-coalescer.js';
import { startAgentMcpServer, stopAgentMcpServer } from './mcp-server.js';
import { getAgentProfile } from './profiles.js';
import type { Dispatch } from './tools.js';

const AGENT_OUTPUT = 'agent-output';
const AGENT_SESSION_ENDED = 'agent-session-ended';

/**
 * Workspace the agent CLI runs in — STABLE across sessions on purpose.
 *
 * Both claude and codex gate an unknown working directory behind a "do you
 * trust this folder?" prompt. With a fresh temp dir per session that prompt
 * came back every single time and swallowed the Quick Action. A stable, empty
 * directory outside any user project is trusted once and then stays trusted.
 */
const WORKSPACE_DIR =
  process.env.KDASH_AGENT_WORKSPACE ?? path.join(os.homedir(), '.kdashboard', 'agent-workspace');

const WORKSPACE_README = `# kdashboard agent workspace

Empty scratch directory kdashboard runs the embedded AI agent CLI in, so the
agent never starts inside one of your projects. Safe to delete.
`;

/** Create the workspace on first use; returns its path. */
function ensureWorkspace(): string {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  const readme = path.join(WORKSPACE_DIR, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, WORKSPACE_README);
  return WORKSPACE_DIR;
}

export type SessionEndReason = 'exit' | 'stopped' | 'replaced' | 'context-switch';

export interface StartAgentSessionArgs {
  profileId: string;
  prompt?: string;
  cols?: number;
  rows?: number;
}

export interface AgentSessionDeps {
  dispatch: Dispatch;
  ctx: HandlerCtx;
  requireApproval: () => boolean;
}

interface AgentSession {
  id: string;
  profileId: string;
  /** Kube context the session started on — the only context it may ever see. */
  pinnedContext: string | undefined;
  pty: pty.IPty;
  output: OutputCoalescer;
  /** Guards double-teardown: exit event after an explicit stop, etc. */
  ended: boolean;
}

let session: AgentSession | null = null;
let contextWatchInstalled = false;
/** ctx of the most recent start — the context-switch watcher emits through it. */
let lastCtx: HandlerCtx | null = null;

export function agentSessionRunning(): boolean {
  return session !== null;
}

async function endSession(reason: SessionEndReason, ctx: HandlerCtx | null, code?: number): Promise<void> {
  const current = session;
  if (!current || current.ended) return;
  current.ended = true;
  session = null;

  current.output.close();
  if (reason !== 'exit') {
    try {
      current.pty.kill();
    } catch {
      // already dead
    }
  }
  // Endpoint dies with the session (which also denies pending approvals).
  // The workspace survives on purpose — see WORKSPACE_DIR.
  await stopAgentMcpServer();
  ctx?.emit(AGENT_SESSION_ENDED, { reason, ...(code !== undefined ? { code } : {}) });
}

/**
 * Start an Agent Session (replacing any live one). Returns the session id and
 * the profile actually launched.
 */
export async function startAgentSession(
  args: StartAgentSessionArgs,
  deps: AgentSessionDeps,
): Promise<{ sessionId: string }> {
  // Kill the previous session first — single slot.
  await endSession('replaced', deps.ctx);

  // Pinned-context kill switch. onConfigChange also fires for changes that
  // keep the context (re-selecting the current one, editing the kubeconfig
  // in-app), so only an actual context switch ends the session.
  if (!contextWatchInstalled) {
    contextWatchInstalled = true;
    onConfigChange(() => {
      if (session && getActiveContextName() !== session.pinnedContext) {
        void endSession('context-switch', lastCtx);
      }
    });
  }
  lastCtx = deps.ctx;

  const profile = getAgentProfile(args.profileId);
  const endpoint = await startAgentMcpServer(deps);

  try {
    const invocation = profile.buildInvocation({
      prompt: args.prompt,
      mcpUrl: endpoint.url,
      mcpToken: endpoint.token,
    });

    const cwd = ensureWorkspace();

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    Object.assign(env, invocation.env);

    const output = makeOutputCoalescer((chunk) => deps.ctx.emit(AGENT_OUTPUT, chunk));
    const child = pty.spawn(profile.binary, invocation.args, {
      name: 'xterm-256color',
      cols: args.cols ?? 80,
      rows: args.rows ?? 24,
      cwd,
      env,
    });

    const created: AgentSession = {
      id: randomUUID(),
      profileId: profile.id,
      pinnedContext: getActiveContextName(),
      pty: child,
      output,
      ended: false,
    };
    session = created;

    child.onData((data) => {
      if (session === created) output.push(data);
    });
    child.onExit(({ exitCode }) => {
      if (session === created) void endSession('exit', deps.ctx, exitCode);
    });

    return { sessionId: created.id };
  } catch (err) {
    await stopAgentMcpServer();
    throw err;
  }
}

/** Write raw bytes to the agent's stdin (keystrokes or Quick Action text). */
export function sendAgentInput(data: string): void {
  if (!session) throw new Error('No agent session');
  session.pty.write(data);
}

export function resizeAgentTerminal(cols: number, rows: number): void {
  if (!session) return;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
  session.pty.resize(cols, rows);
}

export async function stopAgentSession(ctx: HandlerCtx | null): Promise<void> {
  await endSession('stopped', ctx);
}

/** Cleanup for renderer reload/crash and app quit — no event, nobody listens. */
export async function stopAllAgentSessions(): Promise<void> {
  await endSession('stopped', null);
}
