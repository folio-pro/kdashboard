<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    class?: string;
    children?: Snippet;
  }

  let { class: className, children, ...restProps }: Props = $props();
</script>

<div
  class={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
  data-testid="command-list"
  {...restProps}
>
  {#if children}{@render children()}{/if}
</div>
