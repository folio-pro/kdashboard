<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IconComponent } from "$lib/actions/types";

  interface Props {
    title: string;
    icon?: IconComponent;
    /** Drop the bottom hairline (use on the last section). */
    last?: boolean;
    actions?: Snippet;
    children: Snippet;
  }

  let { title, icon: Icon, last = false, actions, children }: Props = $props();
</script>

<section class="px-6 py-5 {last ? '' : 'border-b border-[var(--border-color)]'}">
  <div class="mb-3.5 flex items-center gap-2">
    {#if Icon}
      <Icon class="h-3.5 w-3.5 text-[var(--text-muted)]" />
    {/if}
    <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{title}</span>
    {#if actions}
      <div class="ml-auto flex items-center gap-2">{@render actions()}</div>
    {/if}
  </div>
  {@render children()}
</section>
