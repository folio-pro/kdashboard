import type { Resource, ResourceList } from "../types/index.js";

// --- Types ---

export interface WatchEvent {
  event_type: "Applied" | "Deleted" | "Resync";
  resource_type: string;
  resource: Resource;
}

/**
 * A coalesced watch delta. `reinserted` marks a uid whose pending Deleted was
 * superseded by an Applied inside the same batch — a replay would have removed
 * the row and re-appended it, so the flush must move it to the end.
 */
export interface PendingWatchEvent {
  event: WatchEvent;
  reinserted: boolean;
}

// --- 1. Watch event batching ---

/**
 * Mirrors the batching logic from k8s.svelte.ts:
 * - Events are coalesced into _pendingEvents, keyed by uid: the flush is a
 *   last-write-wins upsert per uid, so only the newest event per resource is
 *   worth keeping — and the buffer stays bounded by the number of distinct
 *   resources even when the flush is throttled (backgrounded window).
 * - A single flush processes all pending events and triggers reactivity once
 * - Resync clears pending events
 * - Scope generation guard prevents stale flushes
 */
export class WatchBatcher {
  resources: ResourceList = { items: [], resource_type: "pods" };
  selectedResource: Resource | null = null;
  selectedResourceType = "pods";
  private _pendingEvents = new Map<string, PendingWatchEvent>();
  private _flushScheduled = false;
  private _scopeGeneration = 0;
  reactivityTriggerCount = 0;
  resyncTriggered = false;

  handleWatchEvent(event: WatchEvent): void {
    if (event.resource_type !== this.selectedResourceType) return;

    if (event.event_type === "Resync") {
      this._pendingEvents.clear();
      this._flushScheduled = false;
      this.resyncTriggered = true;
      return;
    }

    // Events without a uid can never be applied by the flush, so drop them at
    // enqueue time rather than buffering something that would be skipped.
    const uid = event.resource.metadata?.uid;
    if (!uid) return;

    // Coalesce by uid: the newest event supersedes any earlier pending one and
    // keeps its slot — which is what a replay does for an in-place update. The
    // exception is Deleted -> Applied, where a replay removes the row and
    // re-appends it: drop the key so it moves to the end, and flag it so the
    // flush repositions the live row too.
    const prev = this._pendingEvents.get(uid);
    const reinserted = prev?.event.event_type === "Deleted" && event.event_type === "Applied";
    if (reinserted) this._pendingEvents.delete(uid);
    this._pendingEvents.set(uid, {
      event,
      reinserted: reinserted || (prev?.reinserted ?? false),
    });
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      // In real code: scheduleFlush(() => this.flushWatchEvents()) — see
      // $lib/utils/frame-scheduler, which races rAF against a timeout so a
      // backgrounded window still drains.
      // In tests: we call flushWatchEvents() manually
    }
  }

  flushWatchEvents(): void {
    const batch = [...this._pendingEvents.values()];
    this._pendingEvents.clear();
    this._flushScheduled = false;

    const scopeGen = this._scopeGeneration;
    const items = this.resources.items;
    let selectedUpdate: Resource | null | undefined;

    for (const { event, reinserted } of batch) {
      if (this._scopeGeneration !== scopeGen) return;

      const uid = event.resource.metadata?.uid;
      if (!uid) continue;

      if (event.event_type === "Applied") {
        const idx = items.findIndex((r) => r.metadata?.uid === uid);
        if (idx >= 0 && !reinserted) {
          items[idx] = event.resource;
        } else {
          // Reinserted (Deleted -> Applied in one batch): a replay removed the
          // row and re-appended it, so drop the old slot before pushing.
          if (idx >= 0) items.splice(idx, 1);
          items.push(event.resource);
        }
        if (this.selectedResource?.metadata?.uid === uid) {
          selectedUpdate = event.resource;
        }
      } else if (event.event_type === "Deleted") {
        const idx = items.findIndex((r) => r.metadata?.uid === uid);
        if (idx >= 0) {
          items.splice(idx, 1);
          if (this.selectedResource?.metadata?.uid === uid) {
            selectedUpdate = null;
          }
        }
      }
    }

    // Single reactivity trigger
    this.resources = { ...this.resources, items };
    this.reactivityTriggerCount++;

    if (selectedUpdate !== undefined) {
      this.selectedResource = selectedUpdate;
    }
  }

  get pendingCount(): number {
    return this._pendingEvents.size;
  }

  beginScopeChange(): void {
    this._scopeGeneration++;
    this._pendingEvents.clear();
    this._flushScheduled = false;
  }
}

// --- 2. Debounced filter ---

/**
 * Mirrors the debounce logic from ui.svelte.ts:
 * - filter updates immediately (for input display)
 * - _debouncedFilter updates after 150ms timeout
 * - debouncedFilterLower is derived from _debouncedFilter
 * - _clearDebounce synchronizes immediately
 */
export class DebouncedFilter {
  filter = "";
  private _debouncedFilter = "";
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  get debouncedFilterLower(): string {
    return this._debouncedFilter.toLowerCase();
  }

  setFilter(value: string): void {
    this.filter = value;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debouncedFilter = value;
    }, 150);
  }

  clearDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._debouncedFilter = this.filter;
  }

  get hasPendingDebounce(): boolean {
    return this._debounceTimer !== null;
  }
}

// --- 3. Split derived: filter vs sort independence ---

export function filterItems(
  items: Resource[],
  filterLower: string,
  statFilter: string | null,
): Resource[] {
  let result = items;
  if (statFilter) {
    result = result.filter((r) => (r.status?.phase as string) === statFilter);
  }
  if (filterLower) {
    result = result.filter(
      (r) =>
        r.metadata.name.toLowerCase().includes(filterLower) ||
        (r.metadata.namespace ?? "").toLowerCase().includes(filterLower),
    );
  }
  return result;
}

export function sortItems(
  items: Resource[],
  sortColumn: string,
  sortDirection: "asc" | "desc",
): Resource[] {
  return [...items].sort((a, b) => {
    let aVal: string, bVal: string;
    if (sortColumn === "name") {
      aVal = a.metadata.name;
      bVal = b.metadata.name;
    } else {
      aVal = a.metadata.name;
      bVal = b.metadata.name;
    }
    const cmp = aVal.localeCompare(bVal);
    return sortDirection === "asc" ? cmp : -cmp;
  });
}

// --- Composite logic class ---

