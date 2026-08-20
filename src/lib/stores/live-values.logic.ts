// "That number just moved."
//
// k9s refreshes its tables on a timer, so a changing value announces itself by
// the whole screen redrawing. Here the data arrives as watch deltas, which
// repaint a single cell — accurate, but easy to miss when you are watching an
// autoscaler decide whether to add a pod. This module remembers, for a second
// or so, which cells moved and in which direction, so the row can say so.
//
// The comparison happens once per watch delta in the store's flush (the only
// place that sees the old and the new object side by side), NOT per render.

import type { Resource } from "$lib/types";
import { autoscalerFlavor, autoscalerSummary } from "$lib/utils/autoscaler";

/** How long a cell stays marked as just-changed. */
export const FLASH_MS = 1400;

export type ChangeDirection = "up" | "down";

/** One tracked number per column key that should react to a change. */
export type RowSignals = Record<string, number | null>;

/** Extracts the numbers worth flashing from a row, per resource type. */
export type SignalReader = (resource: Resource) => RowSignals;

/**
 * An autoscaler's two volatile numbers: how hard the metric is pushing, and
 * how many pods that is asking for. `desired` rather than `current` — desired
 * is the autoscaler's decision, and it moves first.
 */
function autoscalerSignals(resource: Resource): RowSignals {
  const summary = autoscalerSummary(resource, autoscalerFlavor(resource.kind ?? "") ?? undefined);
  let pressure: number | null = null;
  for (const t of summary.targets) {
    if (t.percent !== null && (pressure === null || t.percent > pressure)) pressure = t.percent;
  }
  return { autoscalerTargets: pressure, autoscalerReplicas: summary.desired };
}

/**
 * The reader for a resource type, or null when the type has nothing worth
 * flashing. Returning null is what keeps the watch flush free of per-event
 * cost for the ~40 resource types that do not opt in.
 */
export function signalsFor(resourceType: string): SignalReader | null {
  return autoscalerFlavor(resourceType) === null ? null : autoscalerSignals;
}

interface Flash {
  direction: ChangeDirection;
  at: number;
}

/** What a row needs to paint: which of its two live values just moved. */
export interface RowFlash {
  targets: ChangeDirection | null;
  replicas: ChangeDirection | null;
}

export const NO_FLASH: RowFlash = { targets: null, replicas: null };

export class LiveValuesLogic {
  /**
   * `${uid}:${column}` -> the flash. A plain Map, deliberately not $state:
   * one entry per changing cell, and proxying them would cost more than the
   * highlight is worth. Rows observe it through `generation` instead.
   */
  _flashes = new Map<string, Flash>();

  /** Bumped whenever the flash set changes, so rows re-read it. */
  generation = 0;

  static key(uid: string, column: string): string {
    return `${uid}:${column}`;
  }

  /**
   * Diff one row's signals and remember what moved. Returns true when anything
   * did, so the caller can schedule the sweep that clears the highlight.
   */
  compare(uid: string, before: RowSignals, after: RowSignals, now: number): boolean {
    let recorded = false;
    for (const column of Object.keys(after)) {
      const from = before[column];
      const to = after[column];
      // A value appearing for the first time is not a change the eye should
      // chase — it is the row filling in.
      if (from === null || from === undefined || to === null || to === undefined) continue;
      if (from === to) continue;
      this._flashes.set(LiveValuesLogic.key(uid, column), {
        direction: to > from ? "up" : "down",
        at: now,
      });
      recorded = true;
    }
    if (recorded) this.generation += 1;
    return recorded;
  }

  /**
   * The flash state of one autoscaler row. Reading `generation` here is what
   * subscribes the caller's `$derived` to the flash starting and expiring, so
   * the table and the detail panel share one lookup instead of each keeping
   * its own copy of the column keys and the reactivity dance.
   */
  rowFlash(uid: string | undefined, now: number): RowFlash {
    void this.generation;
    if (!uid) return NO_FLASH;
    return {
      targets: this.direction(uid, "autoscalerTargets", now),
      replicas: this.direction(uid, "autoscalerReplicas", now),
    };
  }

  /** The direction to show for a cell, or null when it has not just moved. */
  direction(uid: string, column: string, now: number): ChangeDirection | null {
    const flash = this._flashes.get(LiveValuesLogic.key(uid, column));
    if (!flash || now - flash.at >= FLASH_MS) return null;
    return flash.direction;
  }

  /** Drop expired flashes. Returns true when the display should update. */
  sweep(now: number): boolean {
    let dropped = false;
    for (const [key, flash] of this._flashes) {
      if (now - flash.at >= FLASH_MS) {
        this._flashes.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.generation += 1;
    return dropped;
  }

  /** True while something is still highlighted — the sweep's stop condition. */
  get pending(): boolean {
    return this._flashes.size > 0;
  }

  clear(): void {
    if (this._flashes.size === 0) return;
    this._flashes.clear();
    this.generation += 1;
  }
}
