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
  class="flex min-w-0 flex-col gap-1.5 px-4 py-3 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[var(--border-color)]"
  {title}
>
  <span class="truncate whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">{label}</span>
  <span class="flex min-h-[18px] items-center overflow-hidden whitespace-nowrap">
    {#if children}
      {@render children()}
    {:else}
      <span class={mono ? "truncate font-mono text-[13px] tabular-nums text-[var(--text-primary)]" : "truncate text-[12px] text-[var(--text-secondary)]"}>{value ?? "—"}</span>
    {/if}
  </span>
</div>
