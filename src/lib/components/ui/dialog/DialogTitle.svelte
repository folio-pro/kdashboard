<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Dialog } from "bits-ui";
  import type { Snippet } from "svelte";

  interface Props {
    class?: string;
    children?: Snippet;
    [key: string]: unknown;
  }

  let { class: className, children, ...restProps }: Props = $props();
</script>

<Dialog.Title
  class={cn("text-lg font-semibold leading-none tracking-tight text-[var(--text-primary)]", className)}
  {...restProps}
>
  {#if children}{@render children()}{/if}
</Dialog.Title>
