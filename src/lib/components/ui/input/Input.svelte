<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends HTMLInputAttributes {
    class?: string;
  }

  let { class: className, ...restProps }: Props = $props();
</script>

<input
  class={cn(
    "flex h-9 w-full rounded-md border border-[var(--border-color)] bg-transparent px-3 py-1 text-sm text-[var(--text-primary)] shadow-sm transition-colors placeholder:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50",
    className
  )}
  {...restProps}
/>
