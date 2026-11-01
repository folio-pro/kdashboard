<script lang="ts">
  import type { Snippet } from "svelte";

  /** One labelled value in a SummaryStrip. `value` for plain text, children for pills/bars. */
  interface Props {
    label: string;
    value?: string | number | null;
    mono?: boolean;
    title?: string;
    children?: Snippet;
  }

  let { label, value, mono = true, title, children }: Props = $props();
</script>

<div
  class="flex min-w-0 items-center gap-2"
  {title}
>
  <span class="w-24 shrink-0 truncate whitespace-nowrap text-[12px] text-[var(--text-muted)]">{label}</span>
  <span class="flex min-h-5 min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
    {#if children}
      {@render children()}
    {:else}
      <span class={mono ? "truncate font-mono text-[12px] tabular-nums text-[var(--text-primary)]" : "truncate text-[12px] text-[var(--text-primary)]"}>{value ?? "—"}</span>
    {/if}
  </span>
</div>
