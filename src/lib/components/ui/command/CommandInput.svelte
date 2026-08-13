<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Search } from "lucide-svelte";
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends HTMLInputAttributes {
    class?: string;
  }

  let { class: className, ...restProps }: Props = $props();
</script>

<!-- focus-ring-host: the search row is the visible control (icon + input), so it
     owns the focus affordance. Without it the global input:focus-visible ring
     drew a rectangle around the bare input — inset from the row, clipped left
     and right by the dialog's overflow-hidden, and cutting across the row's
     bottom border. -->
<div
  class="focus-ring-host flex items-center border-b border-[var(--border-color)] px-3 transition-colors focus-within:border-[var(--accent)]"
>
  <Search class="mr-2 h-4 w-4 shrink-0 opacity-50" />
  <input
    class={cn(
      "flex h-10 w-full rounded-md bg-transparent py-3 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    data-testid="command-input"
    {...restProps}
  />
</div>
