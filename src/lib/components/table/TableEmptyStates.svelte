<script lang="ts">
  import type { Column } from "$lib/types";
  import { AlertTriangle, Inbox, RefreshCw } from "lucide-svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";

  let {
    state,
    columns,
    resourceTypeLabel,
    error = null,
    hasStatFilter = false,
    hasTextFilter = false,
    onretry,
    onclearStatFilter,
    onclearTextFilter,
  }: {
    state: "loading" | "error" | "empty";
    columns: Column[];
    resourceTypeLabel: string;
    error?: string | null;
    hasStatFilter?: boolean;
    hasTextFilter?: boolean;
    onretry: () => void;
    onclearStatFilter: () => void;
    onclearTextFilter: () => void;
  } = $props();
</script>

{#if state === "loading"}
  <table class="w-full" style="table-layout: fixed;">
    <thead class="sticky top-0 z-10 bg-[var(--bg-secondary)]">
      <tr class="border-b border-[var(--border-hover)]">
        <th class="h-10 px-4 text-center" style="width: 40px;">
          <Skeleton class="mx-auto h-3.5 w-3.5 rounded" />
        </th>
        {#each columns as column}
          <th
            class="h-10 overflow-hidden px-4 text-left"
            style={column.width ? `width: ${column.width}` : ""}
          >
            <Skeleton class="h-3 w-16" />
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each Array(12) as _, i}
        <tr
          class="h-10 border-b border-[var(--border-hover)]"
          style="opacity: {Math.max(0.1, 1 - i * 0.06)}"
        >
          <td class="px-4 text-center" style="width: 40px;">
            <Skeleton class="mx-auto h-3.5 w-3.5 rounded" />
          </td>
          {#each columns as column, j}
            <td
              class="overflow-hidden px-4"
              style={column.width ? `width: ${column.width}` : ""}
            >
              <Skeleton class="h-3 {j === 0 ? 'w-3/4' : 'w-1/2'}" />
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{:else if state === "error"}
  <div class="flex h-full items-center justify-center">
    <div class="flex flex-col items-center gap-3 rounded-lg border border-[var(--status-failed)]/20 bg-[var(--status-failed)]/5 px-8 py-6 text-[var(--status-failed)]">
      <AlertTriangle class="h-6 w-6" />
      <span class="max-w-sm text-center text-xs">{error}</span>
      <button
        class="inline-flex items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
        onclick={onretry}
      >
        <RefreshCw class="h-3.5 w-3.5" />
        Retry
      </button>
    </div>
  </div>
{:else}
  <div class="flex h-full items-center justify-center">
    <div class="flex flex-col items-center gap-3 text-[var(--text-muted)]">
      <Inbox class="h-6 w-6" />
      <span class="text-xs">No {resourceTypeLabel.toLowerCase()} found</span>
      {#if hasStatFilter}
        <button
          class="text-[11px] text-[var(--accent)] hover:underline"
          onclick={onclearStatFilter}
        >
          Clear stat filter
        </button>
      {:else if hasTextFilter}
        <button
          class="text-[11px] text-[var(--accent)] hover:underline"
          onclick={onclearTextFilter}
        >
          Clear filter
        </button>
      {:else}
        <span class="text-[11px] text-[var(--text-dimmed)]">Try switching namespace or context</span>
      {/if}
    </div>
  </div>
{/if}
