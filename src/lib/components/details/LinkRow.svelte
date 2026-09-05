<script lang="ts">
  import { ArrowUpRight } from "lucide-svelte";

  /**
   * One related object: a small kind tag, the name in mono, an arrow. Dense
   * enough to list seven of them where RelCard fits three. Non-navigable
   * rows (a kind the catalog cannot open) render without the button.
   */
  interface Props {
    kind: string;
    name: string;
    /** Tone for the kind tag; defaults to the secondary text colour. */
    color?: string;
    /** Muted trailing note (a host/path, a count). */
    note?: string;
    onclick?: () => void;
  }

  let { kind, name, color = "var(--text-secondary)", note, onclick }: Props = $props();
</script>

{#if onclick}
  <button
    type="button"
    class="group flex w-full min-w-0 items-center gap-2 text-left"
    {onclick}
    title="{kind} {name}"
  >
    <span
      class="shrink-0 rounded-sm px-1.5 py-px text-[10px] font-semibold leading-4"
      style="color: {color}; border: 1px solid color-mix(in srgb, {color} 30%, transparent); background-color: color-mix(in srgb, {color} 8%, transparent);"
    >{kind}</span>
    <span class="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-[var(--text-primary)] group-hover:underline">{name}</span>
    {#if note}<span class="shrink-0 truncate text-[11px] text-[var(--text-muted)]">{note}</span>{/if}
    <ArrowUpRight class="h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
  </button>
{:else}
  <div class="flex w-full min-w-0 items-center gap-2" title="{kind} {name}">
    <span class="shrink-0 rounded-sm border border-[var(--border-color)] px-1.5 py-px text-[10px] font-medium leading-4 text-[var(--text-muted)]">{kind}</span>
    <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-muted)]">{name}</span>
    {#if note}<span class="shrink-0 truncate text-[11px] text-[var(--text-muted)]">{note}</span>{/if}
  </div>
{/if}
