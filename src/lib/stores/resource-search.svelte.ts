// Global resource search for the command palette — the Svelte side of
// components/command-palette/resource-search.logic.ts. Owns the index, the
// lazy load while the palette is open, the context invalidation, and exposes
// ranked hits plus a loading flag; the palette just maps hits to items.

import { invoke } from "$lib/ipc/core";
import type { ResourceList } from "$lib/types";
import { MIN_SEARCH_LENGTH, ResourceSearchIndex, type SearchHit } from "$lib/components/command-palette/resource-search.logic";
import { k8sStore } from "./k8s.svelte";

class ResourceSearchStore {
  private readonly index = new ResourceSearchIndex((resourceType, namespace) =>
    invoke<ResourceList>("list_resources", { resourceType, namespace }).then((r) => r.items),
  );
  private query = $state("");
  /** Bumped as each kind lands so `results` re-ranks. */
  private version = $state(0);
  private context = "";
  loading = $state(false);

  /** Does the query warrant a cluster search at all? */
  get active(): boolean {
    return this.query.trim().length >= MIN_SEARCH_LENGTH;
  }

  results: SearchHit[] = $derived.by(() => {
    this.version;
    return this.active ? this.index.search(this.query) : [];
  });

  /** The palette's input changed (or closed: pass ""). Kicks the lazy load. */
  setQuery(query: string): void {
    this.query = query;
    if (!this.active) return;
    if (k8sStore.currentContext !== this.context) {
      // A context switch changes what every name refers to.
      this.context = k8sStore.currentContext;
      this.index.invalidate();
    }
    this.loading = true;
    void this.index.ensureLoaded(k8sStore.namespaces, () => { this.version++; }).finally(() => { this.loading = false; });
  }
}

export const resourceSearch = new ResourceSearchStore();
