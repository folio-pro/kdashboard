// External MCP endpoint — kdashboard as the Kubernetes MCP server for OTHER
// AI tools (Claude Desktop, Claude Code, Cursor, Codex…), the way Lens ships
// a built-in MCP server. Opt-in from Settings → AI Agent; fixed port and a
// token persisted in settings so a client config keeps working across app
// restarts. Same tool surface and the same in-app Mutation Approval as an
// Agent Session, but NOT pinned to a context: clients see the active one.
//
// Lifecycle: syncExternalMcp() is called at boot and after every settings
// save; it starts, restarts (port/token changed) or stops the endpoint to
// match the settings. Errors (port in use) are kept for the status command,
// never thrown at the caller.

import { externalMcpEndpoint, startExternalMcpServer, stopExternalMcpServer } from './mcp-server.js';
import type { AgentMcpOptions } from './mcp-server.js';

export const EXTERNAL_MCP_DEFAULT_PORT = 47831;

export interface ExternalMcpSettings {
  agent_external_mcp_enabled?: boolean;
  agent_external_mcp_port?: number;
  agent_external_mcp_token?: string;
}

export interface ExternalMcpStatus {
  enabled: boolean;
  running: boolean;
  url?: string;
  error?: string;
}

let lastError: string | null = null;
let lastEnabled = false;
let applied: { port: number; token: string } | null = null;

/** Bring the endpoint in line with `settings`. Idempotent. */
export async function syncExternalMcp(settings: ExternalMcpSettings, options: AgentMcpOptions): Promise<void> {
  const enabled = settings.agent_external_mcp_enabled === true;
  const token = typeof settings.agent_external_mcp_token === 'string' ? settings.agent_external_mcp_token : '';
  const port =
    typeof settings.agent_external_mcp_port === 'number' && Number.isInteger(settings.agent_external_mcp_port)
      ? settings.agent_external_mcp_port
      : EXTERNAL_MCP_DEFAULT_PORT;
  lastEnabled = enabled;

  if (!enabled || token.length === 0) {
    applied = null;
    lastError = enabled ? 'no token configured' : null;
    await stopExternalMcpServer();
    return;
  }
  if (applied && applied.port === port && applied.token === token && externalMcpEndpoint()) return;

  try {
    await startExternalMcpServer({ ...options, port, token });
    applied = { port, token };
    lastError = null;
  } catch (err) {
    applied = null;
    lastError = err instanceof Error ? err.message : String(err);
  }
}

export function externalMcpStatus(): ExternalMcpStatus {
  const endpoint = externalMcpEndpoint();
  return {
    enabled: lastEnabled,
    running: endpoint !== null,
    ...(endpoint ? { url: endpoint.url } : {}),
    ...(lastError ? { error: lastError } : {}),
  };
}

/** App quit / tests. */
export async function stopExternalMcp(): Promise<void> {
  applied = null;
  await stopExternalMcpServer();
}
