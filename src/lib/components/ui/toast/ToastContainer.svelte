<script lang="ts">
  import { toastStore } from "$lib/stores/toast.svelte";
  import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-svelte";
  import { fly } from "svelte/transition";

  const iconMap = {
    success: CheckCircle2,
    error: XCircle,
    warning: AlertTriangle,
    info: Info,
  };

  const colorMap = {
    success: "var(--status-running)",
    error: "var(--status-failed)",
    warning: "var(--status-pending)",
    info: "var(--accent)",
  };
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none" role="status" aria-live="polite">
  {#each toastStore.toasts as toast (toast.id)}
    <div
      class="pointer-events-auto flex items-start gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-lg min-w-[320px] max-w-[420px]"
      transition:fly={{ x: 100, duration: 200 }}
    >
      <svelte:component this={iconMap[toast.type]} class="h-4 w-4 shrink-0 mt-0.5" style="color: {colorMap[toast.type]}" />
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-[var(--text-primary)]">{toast.title}</p>
        {#if toast.description}
          <p class="mt-0.5 text-[11px] text-[var(--text-muted)]">{toast.description}</p>
        {/if}
        {#if toast.action}
          <button
            class="mt-1.5 text-[11px] font-medium hover:underline"
            style="color: {colorMap[toast.type]}"
            onclick={toast.action.onClick}
          >
            {toast.action.label}
          </button>
        {/if}
      </div>
      <button
        class="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        onclick={() => toastStore.dismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  {/each}
</div>
