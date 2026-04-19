import type { Resource, ResourceList } from "../types/index.js";

// --- Types ---

export interface WatchEvent {
  event_type: "Applied" | "Deleted" | "Resync";
  resource_type: string;
  resource: Resource;
}

// --- 1. Watch event batching ---

/**
 * Mirrors the batching logic from k8s.svelte.ts:
 * - Events are queued into _pendingWatchEvents
 * - A single flush processes all pending events and triggers reactivity once
 * - Resync clears pending events
 * - Scope generation guard prevents stale flushes
 */
export class WatchBatcher {
  resources: ResourceList = { items: [], resource_type: "pods" };
  selectedResource: Resource | null = null;
  selectedResourceType = "pods";
  private _pendingEvents: WatchEvent[] = [];
  private _flushScheduled = false;
  private _scopeGeneration = 0;
  reactivityTriggerCount = 0;
  resyncTriggered = false;

  handleWatchEvent(event: WatchEvent): void {
    if (event.resource_type !== this.selectedResourceType) return;

    if (event.event_type === "Resync") {
      this._pendingEvents = [];
      this._flushScheduled = false;
      this.resyncTriggered = true;
      return;
    }

    this._pendingEvents.push(event);
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      // In real code: requestAnimationFrame(() => this.flushWatchEvents())
      // In tests: we call flushWatchEvents() manually
    }
  }

  flushWatchEvents(): void {
    const batch = this._pendingEvents;
    this._pendingEvents = [];
    this._flushScheduled = false;

    const scopeGen = this._scopeGeneration;
    const items = this.resources.items;
    let selectedUpdate: Resource | null | undefined;

    for (const event of batch) {
      if (this._scopeGeneration !== scopeGen) return;

      const uid = event.resource.metadata?.uid;
      if (!uid) continue;

      if (event.event_type === "Applied") {
        const idx = items.findIndex((r) => r.metadata?.uid === uid);
        if (idx >= 0) {
          items[idx] = event.resource;
        } else {
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
    return this._pendingEvents.length;
  }

  beginScopeChange(): void {
    this._scopeGeneration++;
    this._pendingEvents = [];
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

/**
 * Aggregates all performance-related pure logic for testability.
 * The Svelte store extends this and overrides fields with $state.
 */
export class PerformanceStoreLogic {
  watchBatcher = new WatchBatcher();
  debouncedFilter = new DebouncedFilter();

  filterItems(
    items: Resource[],
    filterLower: string,
    statFilter: string | null,
  ): Resource[] {
    return filterItems(items, filterLower, statFilter);
  }

  sortItems(
    items: Resource[],
    sortColumn: string,
    sortDirection: "asc" | "desc",
  ): Resource[] {
    return sortItems(items, sortColumn, sortDirection);
  }
}
