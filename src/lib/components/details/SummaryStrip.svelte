<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The strip under the subtabs: the five to eight numbers that used to be
   * scattered down the page (status, ready, restarts, age…), each a
   * SummaryCell. Auto-fits its columns, so the same cells work in a 440px
   * aside and a full-width tab.
   */
  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div
  class="grid border-b border-[var(--border-color)] bg-[var(--bg-secondary)]"
  style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));"
  data-testid="summary-strip"
>
  {@render children()}
</div>
