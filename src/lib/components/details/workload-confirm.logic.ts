/**
 * Copy and target resolution for the Restart / Rollback confirmation dialogs
 * (WorkloadConfirmDialogs.svelte). Pure so the wording — the one thing the
 * user reads before an irreversible action — is pinned by tests.
 */
import type { Resource } from "$lib/types";
import type { RevisionInfo } from "./revision-history-card.logic";

const PLURAL: Record<string, string> = {
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
};

export function restartTitle(resources: Resource[]): string {
  if (resources.length === 1) return `Restart ${resources[0].kind}`;
  const kinds = new Set(resources.map((r) => r.kind));
  if (kinds.size === 1) {
    const kind = resources[0].kind;
    return `Restart ${resources.length} ${PLURAL[kind] ?? `${kind.toLowerCase()}s`}`;
  }
  return `Restart ${resources.length} workloads`;
}

export function restartMessage(resources: Resource[]): string {
  if (resources.length === 1) {
    const r = resources[0];
    return `Restart ${r.kind} ${r.metadata.name}? Pods will be recreated one by one.`;
  }
  const names = resources.map((r) => r.metadata.name);
  const shown = names.length > 4 ? `${names.slice(0, 4).join(", ")}, …` : names.join(", ");
  return `Restart ${resources.length} workloads (${shown})? Pods will be recreated one by one.`;
}

/**
 * The revision `rollback_deployment` targets when called without one: the
 * second-newest ReplicaSet (the backend list is newest first). Null when the
 * Deployment has only ever had one revision.
 */
export function previousRevision(revisions: RevisionInfo[]): RevisionInfo | null {
  return revisions.length > 1 ? revisions[1] : null;
}

export function rollbackMessage(name: string, target: RevisionInfo): string {
  const images = target.images.length > 0 ? ` (${target.images.join(", ")})` : "";
  return `Roll back ${name} to revision #${target.revision}${images}? Running pods will be replaced with that revision's template.`;
}
