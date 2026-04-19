<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  interface Props {
    heading?: string;
    class?: string;
    children?: Snippet;
  }

  let { heading, class: className, children }: Props = $props();
</script>

<div class={cn("overflow-hidden p-1 text-[var(--text-primary)]", className)}>
  {#if heading}
    <div class="px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)]" data-testid="command-group-label">
      {heading}
    </div>
  {/if}
  {#if children}
    <div data-testid="command-group">
      {@render children()}
    </div>
  {/if}
</div>
