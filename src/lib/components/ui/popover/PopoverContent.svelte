<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Popover } from "bits-ui";
  import type { Snippet } from "svelte";

  interface Props {
    class?: string;
    sideOffset?: number;
    align?: "start" | "center" | "end";
    children?: Snippet;
    [key: string]: unknown;
  }

  let { class: className, sideOffset = 4, align = "center", children, ...restProps }: Props = $props();
</script>

<Popover.Portal>
  <Popover.Content
    {sideOffset}
    {align}
    class={cn(
      "z-50 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-4 text-[var(--text-primary)] shadow-md outline-none",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
      className
    )}
    {...restProps}
  >
    {#if children}{@render children()}{/if}
  </Popover.Content>
</Popover.Portal>
