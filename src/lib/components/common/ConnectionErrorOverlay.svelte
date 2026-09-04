<script lang="ts">
  import { WifiOff, RefreshCw } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  let isRetrying = $state(false);

  // Shared with the views that must stay quiet behind this overlay, so the
  // two can't drift into showing (or hiding) the error independently.
  let showOverlay = $derived(k8sStore.connectionLost);

  // The full-screen overlay is for the boot-time failure only. A cluster
  // that goes away MID-SESSION keeps its (stale) data on screen and gets a
  // banner over the content area instead — read-only work on what was
  // already loaded must stay possible.
  let showBanner = $derived(!showOverlay && !k8sStore.reachable);
  // Anchored to the content area: below the window title bar and the tab
  // bar, right of the sidebar (see App.svelte's grid).
  let bannerLeft = $derived(
    uiStore.sidebarCollapsed ? "var(--sidebar-width-collapsed)" : "var(--sidebar-width-expanded)",
  );

  /**
   * `error` is transient: a later loadResources() clears it before the user
   * has read it, so the overlay ended up showing only the generic fallback
   * and the actual cause ("kubeconfig not found at /nonexistent/path") was
   * lost. contextsLoadError survives until the next successful load, so it is
   * the better second choice — the generic string is a last resort, not a
   * routine outcome.
   */
  let errorMessage = $derived(
    k8sStore.error ?? k8sStore.contextsLoadError ?? "Lost connection to the Kubernetes cluster."
  );

  // One retry for both surfaces: the store's retryConnection is the sequence
  // this overlay always ran (contexts, namespaces, the current list, counts).
  async function handleRetry() {
    isRetrying = true;
    try {
      await k8sStore.retryConnection();
    } finally {
      isRetrying = false;
    }
  }
</script>

{#if showBanner}
  <div
    class="pointer-events-none fixed z-40 flex justify-center px-4"
    style="top: calc(35px + 34px + 8px); left: {bannerLeft}; right: 0;"
  >
    <div
      class="pointer-events-auto flex max-w-2xl items-center gap-3 rounded-lg border border-[var(--status-failed)]/40 bg-[var(--bg-secondary)] px-3 py-1.5 shadow-lg"
      role="status"
      aria-live="polite"
      data-testid="unreachable-banner"
    >
      <WifiOff class="h-3.5 w-3.5 shrink-0 text-[var(--status-failed)]" />
      <span class="truncate text-[12px] text-[var(--text-primary)]">{k8sStore.unreachableTooltip}</span>
      <Button
        variant="toolbar"
        size="xs"
        class="shrink-0"
        onclick={handleRetry}
        disabled={isRetrying}
      >
        <RefreshCw class="h-3 w-3 {isRetrying ? 'animate-spin' : ''}" />
        {isRetrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  </div>
{/if}

{#if showOverlay}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
    <div class="mx-4 flex max-w-md flex-col items-center gap-4 rounded-xl border border-[var(--status-failed)]/30 bg-[var(--bg-secondary)] px-8 py-6 shadow-xl">
      <div class="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--status-failed)]/10">
        <WifiOff class="h-6 w-6 text-[var(--status-failed)]" />
      </div>

      <div class="flex flex-col items-center gap-1 text-center">
        <h2 class="text-[13px] font-semibold text-[var(--text-primary)]">
          Cluster connection lost
        </h2>
        <p class="max-w-xs text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {errorMessage}
        </p>
      </div>

      <div class="flex items-center gap-3">
        <Button
          variant="outline"
          size="md"
          class="rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/10"
          onclick={handleRetry}
          disabled={isRetrying}
        >
          <RefreshCw class="h-3.5 w-3.5 {isRetrying ? 'animate-spin' : ''}" />
          {isRetrying ? "Reconnecting..." : "Retry connection"}
        </Button>
      </div>

      <p class="text-[10px] text-[var(--text-muted)]">
        Check your kubeconfig and cluster availability.
      </p>
    </div>
  </div>
{/if}
