<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    class?: string;
    disabled?: boolean;
    children?: Snippet;
  }

  let { class: className, disabled = false, children, ...restProps }: Props = $props();
</script>

<div
  class={cn(
    "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]",
    disabled && "pointer-events-none opacity-50",
    className
  )}
  role="option"
  aria-selected="false"
  aria-disabled={disabled}
  data-disabled={disabled ? "" : undefined}
  data-testid="command-item"
  {...restProps}
>
  {#if children}{@render children()}{/if}
</div>
