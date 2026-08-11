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

<div class="border-b border-[var(--border-color)]">
  <button
    class="group flex w-full items-center justify-between px-6 py-4 text-left"
    onclick={() => expanded = !expanded}
  >
    <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">{title}</span>
    <div class="flex items-center gap-2">
      {#if count !== undefined}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{count}</span>
      {/if}
      <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-muted)] transition-transform", expanded && "rotate-180")} />
    </div>
  </button>
  {#if expanded && children}
    <div class="pb-3">
      {@render children()}
    </div>
  {/if}
</div>
