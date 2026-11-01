<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The facts under the subtabs (status, ready, restarts, age…), each a
   * SummaryCell, read like `kubectl describe`. Auto-fits its columns: one in a
   * 440px aside, three in a full-width tab, with no half-empty rows of cards.
   */
  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div
  class="grid gap-x-6 gap-y-2 border-b border-[var(--border-color)] p-4"
  style="grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));"
  data-testid="summary-strip"
>
  {@render children()}
</div>
