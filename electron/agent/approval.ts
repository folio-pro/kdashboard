// Mutation Approval broker.
//
// A Safe Mutation requested by an Agent blocks inside its MCP tool call until
// the user approves or denies it in the renderer. The broker owns that
// round-trip: requestApproval() emits `agent-approval-request` to the renderer
// and parks the promise; the renderer answers through the
// `respond_agent_approval` command (registered in handlers.ts) which settles
// it. Deny is the safe default everywhere: on timeout, on teardown of the
// endpoint that asked (other endpoints' requests stay pending), on renderer
// death.

import { randomUUID } from 'node:crypto';

import type { HandlerCtx } from '../dispatch.js';

/** What the user sees in the approval dialog — enough to make it informed. */
export interface ApprovalSummary {
  tool: string;
  /** Kube context the change was reviewed against; execution refuses any other. */
  context: string | undefined;
  resource: { kind: string; namespace?: string; name: string; container?: string };
  /** Human-readable change lines, e.g. "replicas: 3 → 5". */
  changes: string[];
}

/** Which MCP endpoint asked: the Agent Session's own, or the opt-in external one. */
export type ApprovalOrigin = 'session' | 'external';

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  origin: ApprovalOrigin;
  resolve(approved: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingApproval>();

/** Ask the user to approve a Safe Mutation. Resolves false on deny/timeout. */
export function requestApproval(summary: ApprovalSummary, ctx: HandlerCtx, origin: ApprovalOrigin): Promise<boolean> {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, { origin, resolve, timer });
    ctx.emit('agent-approval-request', { id, ...summary });
  });
}

/** Settle a pending approval (renderer answer). Unknown ids are ignored. */
export function respondApproval(id: string, approved: boolean): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(approved);
}

/** Deny what `origin` still has pending — its endpoint stopped and can't deliver an answer. */
export function denyPending(origin: ApprovalOrigin): void {
  for (const [id, entry] of pending) {
    if (entry.origin !== origin) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
}

/** Deny everything still pending, from every origin — the renderer went away. */
export function denyAllPending(): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
}

/** Number of approvals currently waiting on the user (for tests/UI badge). */
export function pendingApprovalCount(): number {
  return pending.size;
}
