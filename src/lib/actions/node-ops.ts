// Node lifecycle operations (cordon / uncordon / drain).
//
// The backend counterpart is electron/handlers/node-ops.ts. Drain is the only
// long-running one: it streams `node-drain-progress` events while it evicts, so
// callers pass an onProgress callback and get the summary when it settles.

import { invoke } from "$lib/ipc/core";
import { listen } from "$lib/ipc/event";
import { k8sStore } from "$lib/stores/k8s.svelte";
import { toastStore } from "$lib/stores/toast.svelte";
import type { Resource } from "$lib/types";

export interface DrainOptions {
  ignoreDaemonSets: boolean;
  deleteEmptyDirData: boolean;
  force: boolean;
  gracePeriodSeconds?: number;
  timeoutSeconds?: number;
}

export interface DrainSkip {
  pod: string;
  namespace: string;
  reason: string;
}

export interface DrainFailure {
  pod: string;
  namespace: string;
  error: string;
}

export interface DrainResult {
  node: string;
  evicted: string[];
  skipped: DrainSkip[];
  failed: DrainFailure[];
  timed_out: boolean;
}

export interface DrainProgress {
  node: string;
  phase: "cordoning" | "listing" | "evicting" | "waiting" | "done";
  evicted: number;
  total: number;
  pod?: string;
}

/** True when the node carries spec.unschedulable. */
export function isCordoned(resource: Resource): boolean {
  return resource.spec?.unschedulable === true;
}

/** Cordon or uncordon a node; toasts and refreshes the table on success. */
export async function setNodeSchedulable(nodeName: string, schedulable: boolean): Promise<void> {
  await invoke("cordon_node", { name: nodeName, unschedulable: !schedulable });
  toastStore.success(
    schedulable ? "Node uncordoned" : "Node cordoned",
    schedulable
      ? `"${nodeName}" accepts new pods again`
      : `"${nodeName}" will not be scheduled onto`,
  );
  await k8sStore.refreshResources();
}

/**
 * Drain a node. Rejects (leaving the node cordoned) when pods block the drain —
 * the message lists them, so the dialog can tell the user which flag to enable.
 */
export async function drainNode(
  nodeName: string,
  options: DrainOptions,
  onProgress?: (p: DrainProgress) => void,
): Promise<DrainResult> {
  const unlisten = onProgress
    ? await listen<DrainProgress>("node-drain-progress", (e) => {
        if (e.payload.node === nodeName) onProgress(e.payload);
      })
    : undefined;

  try {
    return await invoke<DrainResult>("drain_node", { name: nodeName, ...options });
  } finally {
    unlisten?.();
    await k8sStore.refreshResources();
  }
}

/** One-line summary of a finished drain, for the toast body. */
export function summarizeDrain(result: DrainResult): string {
  const parts = [`${result.evicted.length} evicted`];
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
  return parts.join(", ");
}
