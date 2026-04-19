<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Search } from "lucide-svelte";
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends HTMLInputAttributes {
    class?: string;
  }

  let { class: className, ...restProps }: Props = $props();
</script>

<div class="flex items-center border-b border-[var(--border-color)] px-3">
  <Search class="mr-2 h-4 w-4 shrink-0 opacity-50" />
  <input
    class={cn(
      "flex h-10 w-full rounded-md bg-transparent py-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    data-testid="command-input"
    {...restProps}
  />
</div>
