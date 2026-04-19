<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronDown } from "lucide-svelte";
  import { cn } from "$lib/utils";

  interface Props {
    title: string;
    count?: number;
    defaultExpanded?: boolean;
    children?: Snippet;
  }

  let { title, count, defaultExpanded = false, children }: Props = $props();

  // svelte-ignore state_referenced_locally
  let expanded = $state(defaultExpanded);
</script>

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <button
    class="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
    onclick={() => expanded = !expanded}
  >
    <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
    <div class="flex items-center gap-2">
      {#if count !== undefined}
        <span class="text-xs text-[var(--text-muted)]">{count}</span>
      {/if}
      <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-dimmed)] transition-transform", expanded && "rotate-180")} />
    </div>
  </button>
  {#if expanded && children}
    {@render children()}
  {/if}
</div>
