import type { Resource } from "$lib/types";

export interface RevisionInfo {
  revision: number;
  name: string;
  created_at: string | null;
  images: string[];
  replicas: number;
  is_current: boolean;
  /** Pod template YAML (hash label stripped). Absent on older backends. */
  template_yaml?: string;
}

/** Two revisions to diff: `base` (older, left) against `head` (newer, right). */
export interface RevisionDiff {
  base: RevisionInfo;
  head: RevisionInfo;
}

/** Order any two revisions so the older one is the base, whichever was clicked. */
export function orderDiffPair(a: RevisionInfo, b: RevisionInfo): RevisionDiff {
  return a.revision <= b.revision ? { base: a, head: b } : { base: b, head: a };
}

/**
 * The default comparison for a row's "Diff" button: that revision against the
 * one currently serving traffic. Null when the row *is* the current revision
 * (nothing to compare) or the list has no current marker yet.
 */
export function diffAgainstCurrent(revisions: RevisionInfo[], rev: RevisionInfo): RevisionDiff | null {
  const current = revisions.find((r) => r.is_current);
  if (!current || current.name === rev.name) return null;
  return orderDiffPair(rev, current);
}

/** Whether the backend sent templates, i.e. whether diffing is possible at all. */
export function canDiffRevisions(revisions: RevisionInfo[]): boolean {
  return revisions.length > 1 && revisions.every((r) => typeof r.template_yaml === "string");
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
