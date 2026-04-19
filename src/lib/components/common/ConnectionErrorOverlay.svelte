<script lang="ts">
  import { WifiOff, RefreshCw } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";

  let isRetrying = $state(false);

  let showOverlay = $derived(
    k8sStore.connectionStatus === "error" && !k8sStore.isSwitchingContext
  );

  let errorMessage = $derived(
    k8sStore.error ?? "Lost connection to the Kubernetes cluster."
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
        <h2 class="text-sm font-semibold text-[var(--text-primary)]">
          Cluster connection lost
        </h2>
        <p class="max-w-xs text-xs leading-relaxed text-[var(--text-secondary)]">
          {errorMessage}
        </p>
      </div>

      <div class="flex items-center gap-3">
        <button
          class="flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50"
          onclick={handleRetry}
          disabled={isRetrying}
        >
          <RefreshCw class="h-3.5 w-3.5 {isRetrying ? 'animate-spin' : ''}" />
          {isRetrying ? "Reconnecting..." : "Retry connection"}
        </button>
      </div>

      <p class="text-[10px] text-[var(--text-muted)]">
        Check your kubeconfig and cluster availability.
      </p>
    </div>
  </div>
{/if}
