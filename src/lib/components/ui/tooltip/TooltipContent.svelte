<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Tooltip } from "bits-ui";
  import type { Snippet } from "svelte";

  interface Props {
    class?: string;
    sideOffset?: number;
    children?: Snippet;
    [key: string]: unknown;
  }

  let { class: className, sideOffset = 4, children, ...restProps }: Props = $props();
</script>

<Tooltip.Portal>
  <Tooltip.Content
    {sideOffset}
    class={cn(
      "z-50 overflow-hidden rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] px-3 py-1.5 text-xs text-[var(--text-primary)] shadow-md",
      "animate-in fade-in-0 zoom-in-95",
      className
    )}
    {...restProps}
  >
    {#if children}{@render children()}{/if}
  </Tooltip.Content>
</Tooltip.Portal>
