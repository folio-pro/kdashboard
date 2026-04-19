/**
 * Pure derived-logic functions for DetailPanel.
 *
 * These are deliberately free of Svelte runes and component imports so they
 * can be unit-tested in plain TypeScript.
 */

import { SCALABLE_TYPES, RESTARTABLE_TYPES } from "$lib/actions/registry.logic";
export { SCALABLE_TYPES, RESTARTABLE_TYPES };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinimalResource {
  kind?: string;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  // Intentionally loose: the real Resource.metadata has a fixed shape, and the
  // derived helpers only read optional string fields. Using a plain object with
  // optional fields accepts both a full ResourceMetadata and ad-hoc test shapes.
  metadata?: { name?: string; namespace?: string };
}

// ---------------------------------------------------------------------------
// Individual derivations
// ---------------------------------------------------------------------------

export function deriveKind(resource: MinimalResource | null | undefined): string {
  return resource?.kind?.toLowerCase() ?? "";
}

export function deriveShowLogsButton(kind: string): boolean {
  return kind === "pod" || kind === "deployment";
}

export function deriveNodeName(resource: MinimalResource | null | undefined): string {
  return (
    (resource?.spec?.nodeName as string) ??
    (resource?.status?.nodeName as string) ??
    ""
  );
}

export function deriveResourceType(kind: string): string {
  return kind + "s";
}

export function deriveIsScalable(resourceType: string): boolean {
  return SCALABLE_TYPES.includes(resourceType);
}

export function deriveIsRestartable(resourceType: string): boolean {
  return RESTARTABLE_TYPES.includes(resourceType);
}

export function deriveIsRollbackable(kind: string): boolean {
  return kind === "deployment";
}

export function deriveCurrentReplicas(
  resource: MinimalResource | null | undefined,
): number {
  return (resource?.spec?.replicas as number) ?? 0;
}

// ---------------------------------------------------------------------------
// Aggregate helper
// ---------------------------------------------------------------------------

export function deriveAll(resource: MinimalResource | null | undefined) {
  const kind = deriveKind(resource);
  const resourceType = deriveResourceType(kind);
  return {
    kind,
    resourceType,
    showLogsButton: deriveShowLogsButton(kind),
    nodeName: deriveNodeName(resource),
    isScalable: deriveIsScalable(resourceType),
    isRestartable: deriveIsRestartable(resourceType),
    isRollbackable: deriveIsRollbackable(kind),
    currentReplicas: deriveCurrentReplicas(resource),
  };
}
