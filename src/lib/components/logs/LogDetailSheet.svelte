<script lang="ts">
  import { cn } from "$lib/utils";
  import { Copy, Check } from "lucide-svelte";
  import { Sheet, SheetContent } from "$lib/components/ui/sheet";
  import type { LogLine } from "./log-viewer";
  import { LEVEL_LABELS, LEVEL_PILL_COLORS, MESSAGE_COLORS } from "./log-constants";
  import { getJsonHighlighted } from "./log-highlighting";

  let {
    selectedLog,
    onClose,
  }: {
    selectedLog: LogLine | null;
    onClose: () => void;
  } = $props();

  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  let sheetOpen = $derived(selectedLog !== null);

  function handleSheetChange(open: boolean) {
    if (!open) onClose();
  }

  async function copyLogContent() {
    if (!selectedLog) return;
    await navigator.clipboard.writeText(selectedLog.jsonFormatted ?? selectedLog.message);
    if (copiedTimer) clearTimeout(copiedTimer);
    copied = true;
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }
</script>

<Sheet open={sheetOpen} onOpenChange={handleSheetChange}>
  <SheetContent side="right" overlay={false} interactOutside={false} class="w-[480px]">
    {#if selectedLog}
      <!-- Header -->
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-5 pr-12">
        <span class="font-mono text-sm font-semibold text-[var(--text-primary)]">Log Detail</span>
        <button
          class="flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          onclick={copyLogContent}
          title="Copy"
        >
          {#if copied}
            <Check class="h-3.5 w-3.5 text-[var(--status-running)]" />
          {:else}
            <Copy class="h-3.5 w-3.5" />
          {/if}
        </button>
      </div>

      <!-- Metadata -->
      <div class="flex shrink-0 flex-col gap-2 border-b border-[var(--border-color)] px-5 py-3">
        <div class="flex items-center gap-2">
          <span
            class={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
              LEVEL_PILL_COLORS[selectedLog.level],
            )}
          >
            {LEVEL_LABELS[selectedLog.level]}
          </span>
          {#if selectedLog.isJson}
            <span class="rounded bg-[var(--log-json)]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--log-json)]">
              JSON
            </span>
          {/if}
        </div>
        {#if selectedLog.podName}
          <span class="font-mono text-[11px] text-[var(--text-muted)]">pod: {selectedLog.podName}</span>
        {/if}
        {#if selectedLog.timestamp}
          <span class="font-mono text-[11px] text-[var(--text-muted)]">{selectedLog.timestamp}</span>
        {/if}
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-5">
        {#if selectedLog.isJson && selectedLog.jsonFormatted}
          <pre class="whitespace-pre-wrap break-all font-mono text-[11px] leading-[20px] text-[var(--text-secondary)]">{@html getJsonHighlighted(selectedLog)}</pre>
        {:else}
          <pre
            class={cn(
              "whitespace-pre-wrap break-all font-mono text-[11px] leading-[20px]",
              MESSAGE_COLORS[selectedLog.level],
            )}
          >{selectedLog.message}</pre>
        {/if}
      </div>
    {/if}
  </SheetContent>
</Sheet>
