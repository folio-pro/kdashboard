/**
 * Pure logic functions for ScaleDialog.
 *
 * These are deliberately free of Svelte runes and component imports so they
 * can be unit-tested in plain TypeScript.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { ScaleResourceInfo } from "$lib/stores/dialogs.logic";
export type ScaleResource = ScaleResourceInfo;

export interface ScaleDialogState {
  open: boolean;
  replicas: number;
  loading: boolean;
  error: string;
  resource: ScaleResource;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createResource(overrides?: Partial<ScaleResource>): ScaleResource {
  return {
    kind: "Deployment",
    name: "my-app",
    namespace: "default",
    currentReplicas: 3,
    ...overrides,
  };
}

export function createState(resource?: ScaleResource): ScaleDialogState {
  const res = resource ?? createResource();
  return {
    open: false,
    replicas: 0,
    loading: false,
    error: "",
    resource: res,
  };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/** Decrement replicas, clamped to 0. */
export function decrementReplicas(current: number): number {
  return Math.max(0, current - 1);
}

/** Increment replicas by 1. */
export function incrementReplicas(current: number): number {
  return current + 1;
}

/** Whether the "Scale" button should be enabled. */
export function isScaleEnabled(
  loading: boolean,
  replicas: number,
  currentReplicas: number,
): boolean {
  return !loading && replicas !== currentReplicas;
}

/** Whether to show the "current -> new" delta label. */
export function shouldShowDelta(
  currentReplicas: number,
  replicas: number,
): boolean {
  return currentReplicas !== replicas;
}

/** Reset state when the dialog opens. */
export function onOpen(state: ScaleDialogState): void {
  if (state.open && state.resource) {
    state.replicas = state.resource.currentReplicas;
    state.error = "";
  }
}

/** Label for the primary action button. */
export function getButtonLabel(loading: boolean): string {
  return loading ? "Scaling..." : "Scale";
}
