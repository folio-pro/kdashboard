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
    <thead class="sticky top-0 z-10 bg-[var(--bg-primary)]">
      <tr class="border-b border-[var(--border-color)]">
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
          class="h-11 border-b border-[var(--border-color)]"
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
    <div class="flex max-w-md flex-col items-center gap-4 px-10 py-16 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 text-[var(--status-failed)]">
        <AlertTriangle class="h-6 w-6" />
      </div>
      <div class="text-[15px] font-semibold text-[var(--text-primary)]">Unable to reach cluster</div>
      <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">{error}</p>
      <button
        class="mt-1 inline-flex items-center gap-1.5 rounded-md border border-[var(--border-hover)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-color)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        onclick={onretry}
      >
        <RefreshCw class="h-3.5 w-3.5" />
        Retry connection
      </button>
    </div>
  </div>
{:else}
  <div class="flex h-full items-center justify-center">
    <div class="flex max-w-md flex-col items-center gap-4 px-10 py-16 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
        <Inbox class="h-6 w-6" />
      </div>
      <div class="text-[15px] font-semibold text-[var(--text-primary)]">No {resourceTypeLabel.toLowerCase()} found</div>
      {#if hasStatFilter}
        <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">No resources match the active stat filter.</p>
        <button
          class="mt-1 text-[12px] text-[var(--accent)] hover:underline"
          onclick={onclearStatFilter}
        >
          Clear stat filter
        </button>
      {:else if hasTextFilter}
        <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">No resources match your search.</p>
        <button
          class="mt-1 text-[12px] text-[var(--accent)] hover:underline"
          onclick={onclearTextFilter}
        >
          Clear filter
        </button>
      {:else}
        <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">There are none in this namespace. Try switching namespace or context to see results.</p>
      {/if}
    </div>
  </div>
{/if}
