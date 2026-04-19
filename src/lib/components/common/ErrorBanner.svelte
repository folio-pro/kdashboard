<script lang="ts">
  import { AlertTriangle, RefreshCw, X } from "lucide-svelte";

  let { message, onretry, ondismiss }: {
    message: string;
    onretry?: () => void;
    ondismiss?: () => void;
  } = $props();
</script>

<div class="flex items-center gap-3 rounded-lg border border-[var(--status-failed)]/20 bg-[var(--status-failed)]/5 px-4 py-2.5 animate-slide-in-up">
  <AlertTriangle class="h-4 w-4 shrink-0 text-[var(--status-failed)]" />
  <p class="flex-1 text-xs text-[var(--text-primary)]">{message}</p>
  {#if onretry}
    <button
      class="flex items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
      onclick={onretry}
    >
      <RefreshCw class="h-3 w-3" />
      Retry
    </button>
  {/if}
  {#if ondismiss}
    <button
      class="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
      onclick={ondismiss}
    >
      <X class="h-3.5 w-3.5" />
    </button>
  {/if}
</div>
