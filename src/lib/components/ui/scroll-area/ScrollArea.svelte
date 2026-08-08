<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    class?: string;
    orientation?: "vertical" | "horizontal";
    children?: Snippet;
  }

  let { class: className, orientation = "vertical", children, ...restProps }: Props = $props();
</script>

<div
  class={cn("relative overflow-hidden", className)}
  {...restProps}
>
  <!-- No scrollbar hiding here: the overflow-* classes pick up the global
       thin show-on-hover scrollbar styling, same as every plain scroll
       container (e.g. the sidebar). -->
  <div
    class={cn(
      "h-full w-full",
      orientation === "horizontal" ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto overflow-x-hidden"
    )}
  >
    {#if children}{@render children()}{/if}
  </div>
</div>
