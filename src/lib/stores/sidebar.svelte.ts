const STORAGE_KEY = "kdash:sidebar";

/**
 * Per-section collapse state and the nav filter.
 *
 * The sidebar was a deliberately flat, non-collapsible list. That reads fine
 * on a bare cluster, but CRD discovery appends one section per API group, so
 * on a cluster with cert-manager, calico, istio, argo and friends the nav
 * becomes dozens of sticky headers in a single unbounded scroll with no way
 * to fold anything away and no way to search. Pinning was the only escape.
 *
 * Kept out of settingsStore on purpose: that persists to disk through the
 * Electron main process and is synced as user configuration, whereas this is
 * disposable per-machine view state, so localStorage is the right home.
 */
class SidebarStore {
  /** Titles of collapsed sections. Array (not Set) so it serialises directly. */
  collapsed = $state<string[]>([]);
  /** Nav filter query. Deliberately NOT persisted — a filter that survives a
   *  restart looks like a sidebar that has lost half its entries. */
  filter = $state("");

  constructor() {
    this.#hydrate();
    this.#installAutosave();
  }

  #hydrate(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { collapsed?: unknown };
      if (Array.isArray(parsed?.collapsed)) {
        this.collapsed = parsed.collapsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // Corrupt or unavailable storage — start expanded, which is the state
      // the sidebar had before this existed.
    }
  }

  #installAutosave(): void {
    if (typeof localStorage === "undefined") return;
    $effect.root(() => {
      $effect(() => {
        const snapshot = JSON.stringify({ collapsed: [...this.collapsed] });
        try {
          localStorage.setItem(STORAGE_KEY, snapshot);
        } catch {
          // Quota exceeded or storage disabled — collapse state is best-effort.
        }
      });
    });
  }

  isCollapsed(title: string): boolean {
    return this.collapsed.includes(title);
  }

  toggle(title: string): void {
    this.collapsed = this.isCollapsed(title)
      ? this.collapsed.filter((t) => t !== title)
      : [...this.collapsed, title];
  }

  expandAll(): void {
    this.collapsed = [];
  }
}

export const sidebarStore = new SidebarStore();
