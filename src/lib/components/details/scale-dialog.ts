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

// ---------------------------------------------------------------------------
// Autoscaler awareness
// ---------------------------------------------------------------------------

export interface OwningAutoscaler {
  name: string;
  min: number | null;
  max: number | null;
}

/**
 * The HorizontalPodAutoscaler whose scaleTargetRef is this workload, if any.
 * The dialog shows it before the user commits: a manual scale under an HPA is
 * overwritten on the controller's next sync, which the detail page said but
 * the dialog — where the decision is made — did not.
 */
export function findOwningAutoscaler(
  autoscalers: Array<{ metadata: { name: string; namespace?: string | null }; spec?: Record<string, unknown> }>,
  target: { kind: string; name: string; namespace: string },
): OwningAutoscaler | null {
  for (const hpa of autoscalers) {
    if ((hpa.metadata.namespace ?? "") !== target.namespace) continue;
    const ref = hpa.spec?.scaleTargetRef as { kind?: string; name?: string } | undefined;
    if (!ref || ref.name !== target.name) continue;
    if ((ref.kind ?? "").toLowerCase() !== target.kind.toLowerCase()) continue;
    const min = hpa.spec?.minReplicas;
    const max = hpa.spec?.maxReplicas;
    return {
      name: hpa.metadata.name,
      min: typeof min === "number" ? min : null,
      max: typeof max === "number" ? max : null,
    };
  }
  return null;
}

/** The warning line for a scale under an autoscaler, or "" when there is none. */
export function autoscalerWarning(hpa: OwningAutoscaler | null, replicas: number): string {
  if (!hpa) return "";
  const range = hpa.min !== null && hpa.max !== null ? ` (${hpa.min}–${hpa.max})` : "";
  const outside =
    (hpa.min !== null && replicas < hpa.min) || (hpa.max !== null && replicas > hpa.max)
      ? " This value is outside its range, so it will be corrected immediately."
      : " The HPA will override this value on its next sync.";
  return `Managed by HPA ${hpa.name}${range}.${outside}`;
}
