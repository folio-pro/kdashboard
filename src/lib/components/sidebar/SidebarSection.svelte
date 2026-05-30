<script lang="ts">
  import { cn } from "$lib/utils";
  import { ChevronDown } from "lucide-svelte";
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    collapsed: boolean;
    sidebarCollapsed: boolean;
    ontoggle: () => void;
    children: Snippet;
  }

  let { title, collapsed, sidebarCollapsed, ontoggle, children }: Props = $props();
</script>

<div>
  {#if !sidebarCollapsed}
    <button
      class={cn(
        "flex w-full items-center justify-between px-2.5 pt-[7px] pb-1.5",
        "text-[10.5px] font-semibold uppercase tracking-[0.09em]",
        "text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      )}
      onclick={ontoggle}
    >
      <span>{title}</span>
      <ChevronDown
        class={cn(
          "h-3.5 w-3.5 shrink-0 text-[var(--text-dimmed)] transition-transform",
          collapsed && "-rotate-90"
        )}
      />
    </button>
  {/if}

  {#if !collapsed || sidebarCollapsed}
    <div class="flex flex-col gap-0.5 px-2 overflow-hidden">
      {@render children()}
    </div>
  {/if}
</div>
