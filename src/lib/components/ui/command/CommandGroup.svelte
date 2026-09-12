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

<!-- role=group inside the palette's listbox; the heading labels the group, so
     it is presentational to avoid being announced separately. -->
<div
  class={cn("overflow-hidden p-1 text-[var(--text-primary)]", className)}
  role="group"
  aria-label={heading}
>
  {#if heading}
    <div role="presentation" class="px-2 py-1.5 text-[12px] font-medium text-[var(--text-secondary)]" data-testid="command-group-label">
      {heading}
    </div>
  {/if}
  {#if children}
    <div role="presentation" data-testid="command-group">
      {@render children()}
    </div>
  {/if}
</div>
