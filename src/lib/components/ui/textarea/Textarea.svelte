<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLTextareaAttributes } from "svelte/elements";

  /** Multi-line Input: same border, focus ring and mono option. */
  interface Props extends HTMLTextareaAttributes {
    mono?: boolean;
    class?: string;
  }

  let { mono = false, class: className, ...rest }: Props = $props();
</script>

<textarea
  class={cn(
    "w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] transition-colors placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50",
    mono && "font-mono text-[11px]",
    className,
  )}
  {...rest}
></textarea>
