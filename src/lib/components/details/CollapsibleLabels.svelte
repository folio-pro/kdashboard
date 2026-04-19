<script lang="ts">
  import { ChevronDown } from "lucide-svelte";
  import { cn } from "$lib/utils";

  interface Props {
    title?: string;
    labels: Record<string, string>;
    selector?: Record<string, string>;
  }

  let { title = "Labels", labels, selector }: Props = $props();

  let expanded = $state(false);

  let mergedLabels = $derived.by(() => {
    if (!selector || Object.keys(selector).length === 0) return labels;
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(selector)) merged[k] = v;
    for (const [k, v] of Object.entries(labels)) merged[k] = v;
    return merged;
  });

  let displayTitle = $derived(
    selector && Object.keys(selector).length > 0 ? "Labels & Selector" : title
  );
</script>

{#if Object.keys(mergedLabels).length > 0}
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <button
      class="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
      onclick={() => expanded = !expanded}
    >
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">{displayTitle}</h3>
      <div class="flex items-center gap-2">
        <span class="text-xs text-[var(--text-muted)]">{Object.keys(mergedLabels).length}</span>
        <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-dimmed)] transition-transform", expanded && "rotate-180")} />
      </div>
    </button>
    {#if expanded}
      {#each Object.entries(mergedLabels) as [key, value]}
        <div class="flex items-center border-t border-[var(--border-hover)] px-5 py-3">
          <span class="truncate font-mono text-[11px] text-[var(--text-muted)]">
            {#if selector && key in selector}
              <span class="mr-1.5 inline-flex items-center rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-dimmed)]">selector</span>
            {/if}
            {key}=<span class="text-[var(--text-primary)]">{value}</span>
          </span>
        </div>
      {/each}
    {/if}
  </div>
{/if}
