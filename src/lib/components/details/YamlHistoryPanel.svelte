<script lang="ts">
  import { cn } from "$lib/utils";
  import { RotateCcw } from "lucide-svelte";

  interface HistoryEntry {
    yaml: string;
    timestamp: Date;
    label: string;
  }

  let {
    entries,
    selectedIndex = null,
    diffContainer = $bindable<HTMLDivElement | null>(null),
    onselect,
    onrestore,
  }: {
    entries: HistoryEntry[];
    selectedIndex: number | null;
    diffContainer?: HTMLDivElement | null;
    onselect: (index: number) => void;
    onrestore: (index: number) => void;
  } = $props();

  function formatTime(date: Date): string {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
</script>

{#if entries.length <= 1}
  <div class="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
    No edit history yet. Changes will appear here after saving.
  </div>
{:else}
  <div class="flex h-full">
    <!-- History list -->
    <div class="w-[240px] shrink-0 overflow-y-auto border-r border-[var(--border-color)] bg-[var(--bg-secondary)]">
      {#each entries as entry, i}
        <button
          class={cn(
            "flex w-full flex-col gap-0.5 border-b border-[var(--border-color)] px-3 py-2.5 text-left transition-colors",
            selectedIndex === i
              ? "bg-[var(--accent)]/10 text-[var(--text-primary)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          )}
          onclick={() => { onselect(i); }}
        >
          <span class="text-[11px] font-medium">{entry.label}</span>
          <span class="text-[10px] text-[var(--text-muted)]">{formatTime(entry.timestamp)}</span>
        </button>
      {/each}
    </div>

    <!-- History diff view -->
    <div class="min-h-0 flex-1">
      {#if selectedIndex !== null}
        <div class="flex h-full flex-col">
          <div class="flex shrink-0 items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1.5">
            <div class="flex items-center gap-4 text-[10px] text-[var(--text-muted)]">
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-[var(--status-failed)]/30"></span>
                Before
              </span>
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-[var(--status-running)]/30"></span>
                After
              </span>
            </div>
            <button
              class="flex h-[28px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              onclick={() => onrestore(selectedIndex!)}
            >
              <RotateCcw class="h-3 w-3" />
              Restore this version
            </button>
          </div>
          <div bind:this={diffContainer} class="min-h-0 flex-1 overflow-hidden"></div>
        </div>
      {:else}
        <div class="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
          Select a version to view changes
        </div>
      {/if}
    </div>
  </div>
{/if}
