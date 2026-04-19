import type { Resource } from "$lib/types";

export interface RevisionInfo {
  revision: number;
  name: string;
  created_at: string | null;
  images: string[];
  replicas: number;
  is_current: boolean;
}

/**
 * Stable identity key for a resource. When the key changes the UI must drop any
 * stale pendingRevision so confirmRollback cannot target the previous deployment.
 */
export function resourceKey(resource: {
  metadata: { name: string; namespace?: string };
}): string {
  return `${resource.metadata.namespace ?? ""}:${resource.metadata.name}`;
}

export interface RollbackDeps {
  rollback: (resource: Resource, revision: number) => Promise<unknown>;
  fetchRevisions: () => Promise<RevisionInfo[]>;
  notifyError: (title: string, detail: string) => void;
}

export interface RollbackOutcome {
  ok: boolean;
  revisions: RevisionInfo[] | null;
  error: string | null;
}

/**
 * Execute a deployment rollback against `target.revision` and refresh revisions.
 * The target is captured explicitly so the API call cannot race against a later
 * pendingRevision set by the user. A failure in the rollback *or* the refetch is
 * surfaced via notifyError and reflected in the returned outcome.
 */
export async function performRollback(
  resource: Resource,
  target: RevisionInfo,
  deps: RollbackDeps,
): Promise<RollbackOutcome> {
  try {
    await deps.rollback(resource, target.revision);
    const revisions = await deps.fetchRevisions();
    return { ok: true, revisions, error: null };
  } catch (err) {
    const detail = String(err);
    deps.notifyError("Rollback failed", detail);
    return { ok: false, revisions: null, error: detail };
  }
}
