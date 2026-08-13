<script lang="ts">
  import { WifiOff, RefreshCw } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { k8sStore } from "$lib/stores/k8s.svelte";

  let isRetrying = $state(false);

  // Shared with the views that must stay quiet behind this overlay, so the
  // two can't drift into showing (or hiding) the error independently.
  let showOverlay = $derived(k8sStore.connectionLost);

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

  async function handleRetry() {
    isRetrying = true;
    try {
      await k8sStore.loadContexts();
      if (k8sStore.connectionStatus === "connected") {
        await k8sStore.loadNamespaces();
        await k8sStore.loadResources(k8sStore.selectedResourceType);
        k8sStore.loadAllResourceCounts();
      }
    } finally {
      isRetrying = false;
    }
  }
</script>

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
