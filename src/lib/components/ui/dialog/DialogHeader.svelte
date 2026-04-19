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
  class={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
  {...restProps}
>
  {#if children}{@render children()}{/if}
</div>
