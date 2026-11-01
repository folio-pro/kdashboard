<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    /** Drop the bottom hairline (use on the last section). */
    last?: boolean;
    actions?: Snippet;
    children: Snippet;
  }

  let { title, last = false, actions, children }: Props = $props();
</script>

<section class="p-4 {last ? '' : 'border-b border-[var(--border-color)]'}">
  <div class="mb-2 flex items-center gap-2">
    <h3 class="text-[13px] font-medium text-[var(--text-primary)]">{title}</h3>
    {#if actions}
      <div class="ml-auto flex items-center gap-2">{@render actions()}</div>
    {/if}
  </div>
  {@render children()}
</section>
