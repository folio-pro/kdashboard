// Mutation Approval broker.
//
// A Safe Mutation requested by an Agent blocks inside its MCP tool call until
// the user approves or denies it in the renderer. The broker owns that
// round-trip: requestApproval() emits `agent-approval-request` to the renderer
// and parks the promise; the renderer answers through the
// `respond_agent_approval` command (registered in handlers.ts) which settles
// it. Deny is the safe default everywhere: on timeout, on session teardown,
// on renderer death.

import { randomUUID } from 'node:crypto';

import type { HandlerCtx } from '../dispatch.js';

/** What the user sees in the approval dialog — enough to make it informed. */
export interface ApprovalSummary {
  tool: string;
  resource: { kind: string; namespace?: string; name: string; container?: string };
  /** Human-readable change lines, e.g. "replicas: 3 → 5". */
  changes: string[];
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  resolve(approved: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingApproval>();

/** Ask the user to approve a Safe Mutation. Resolves false on deny/timeout. */
export function requestApproval(summary: ApprovalSummary, ctx: HandlerCtx): Promise<boolean> {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
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

/** Deny everything still pending — session ended or renderer went away. */
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
