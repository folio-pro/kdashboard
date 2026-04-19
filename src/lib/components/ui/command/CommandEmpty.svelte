<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  interface Props {
    class?: string;
    children?: Snippet;
  }

  let { class: className, children }: Props = $props();
</script>

<div class={cn("py-6 text-center text-sm text-[var(--text-secondary)]", className)} data-testid="command-empty">
  {#if children}{@render children()}{/if}
</div>
