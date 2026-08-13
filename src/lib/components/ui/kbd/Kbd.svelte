<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  /**
   * Keyboard hint. Nine `<kbd>` elements existed across the app in five
   * different spellings (px-1 vs px-1.5, with and without py, bordered on
   * --border-color vs --border-hover, mono vs sans). One spelling now.
   */
  interface Props extends HTMLAttributes<HTMLElement> {
    class?: string;
  }

  let { class: className, children, ...restProps }: Props = $props();
</script>

<kbd
  class={cn(
    "inline-flex shrink-0 items-center rounded-sm border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] leading-[14px] text-[var(--text-muted)]",
    className
  )}
  {...restProps}
>
  {@render children?.()}
</kbd>
