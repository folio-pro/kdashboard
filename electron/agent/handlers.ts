// Agent handler group — the IPC surface of the embedded AI agent feature.
//
// Commands (snake_case, via the k8s:invoke dispatcher):
//   - get_agent_profiles      {}                                    -> AgentProfileStatus[]
//   - start_agent_session     { profileId, prompt?, cols?, rows? }  -> { sessionId }
//   - send_agent_input        { data }                              -> null
//   - resize_agent_terminal   { cols, rows }                        -> null
//   - stop_agent_session      {}                                    -> null
//   - respond_agent_approval  { id, approved }                      -> null
//
// The session's MCP tools re-enter the SAME dispatcher the renderer uses; the
// register() hook captures the shared handler map, so no extra wiring in
// main.ts is needed. The Mutation Approval toggle is injected via
// setRequireApprovalProvider() (main.ts binds it to settings; tests inject
// their own) — this module must stay importable without electron.

import type { HandlerCtx, HandlerMap } from '../dispatch.js';
import { respondApproval } from './approval.js';
import { getAgentProfileStatuses } from './profiles.js';
import {
  resizeAgentTerminal,
  sendAgentInput,
  startAgentSession,
  stopAgentSession,
} from './session.js';

/** Default: always require Mutation Approval. main.ts binds this to settings. */
let requireApprovalProvider: () => boolean = () => true;

export function setRequireApprovalProvider(provider: () => boolean): void {
  requireApprovalProvider = provider;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`Missing or invalid '${key}' argument`);
  return v;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
  // Self-dispatch: agent MCP tools drive the same commands the renderer does.
  const dispatch = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(cmd);
    if (!handler) throw new Error(`Unknown command: ${cmd}`);
    return handler(args ?? {}, ctx);
  };

  handlers.set('get_agent_profiles', async () => getAgentProfileStatuses());

  handlers.set('start_agent_session', async (args) =>
    startAgentSession(
      {
        profileId: reqStr(args, 'profileId'),
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        cols: optNum(args, 'cols'),
        rows: optNum(args, 'rows'),
      },
      { dispatch, ctx, requireApproval: () => requireApprovalProvider() },
    ),
  );

  handlers.set('send_agent_input', (args) => {
    sendAgentInput(reqStr(args, 'data'));
    return null;
  });

  handlers.set('resize_agent_terminal', (args) => {
    const cols = optNum(args, 'cols');
    const rows = optNum(args, 'rows');
    if (cols !== undefined && rows !== undefined) resizeAgentTerminal(cols, rows);
    return null;
  });

  handlers.set('stop_agent_session', async () => {
    await stopAgentSession(ctx);
    return null;
  });

  handlers.set('respond_agent_approval', (args) => {
    respondApproval(reqStr(args, 'id'), args.approved === true);
    return null;
  });
}
