<script lang="ts">
  import { onMount } from "svelte";

  /**
   * The line under the table that says what the view is doing: whether the
   * watch is live, how many of the rows you are seeing, what is hidden and
   * why, and how stale the list is. Everything here used to be either
   * invisible (watch state, staleness) or scattered (the count in the header).
   */
  interface Props {
    shown: number;
    total: number;
    watching: boolean;
    /** Epoch ms of the last list/delta; 0 = never. */
    lastUpdatedAt: number;
    /** Namespace column is auto-hidden because one namespace is selected. */
    namespaceHidden: boolean;
    /** Typed facets + stat filter + text, counted. */
    activeFilters: number;
    onclearFilters: () => void;
  }

  let { shown, total, watching, lastUpdatedAt, namespaceHidden, activeFilters, onclearFilters }: Props = $props();

  // A 5s tick is enough for "updated 12s ago"; ageTick (30s) is too coarse
  // for the first minute, which is when staleness matters.
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => { now = Date.now(); }, 5_000);
    return () => clearInterval(timer);
  });

  let updatedLabel = $derived.by(() => {
    if (!lastUpdatedAt) return "";
    const s = Math.max(0, Math.round((now - lastUpdatedAt) / 1000));
    if (s < 5) return "updated just now";
    if (s < 60) return `updated ${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `updated ${m}m ago`;
    return `updated ${Math.floor(m / 60)}h ago`;
  });
</script>

<footer
  class="flex h-[26px] shrink-0 items-center gap-2.5 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-6 text-[11px] text-[var(--text-muted)]"
  aria-label="Table status"
>
  <span class="inline-flex shrink-0 items-center gap-1.5" style:color={watching ? "var(--status-running)" : "var(--text-muted)"}>
    <span
      class="h-[5px] w-[5px] rounded-full"
      style:background-color={watching ? "var(--status-running)" : "var(--text-muted)"}
      style:box-shadow={watching ? "0 0 6px color-mix(in srgb, var(--status-running) 55%, transparent)" : "none"}
    ></span>
    {watching ? "Watching" : "Not watching"}
  </span>

  <!-- The one live region for the row count: the toolbar used to carry an
       sr-only twin, which read every watch delta twice. -->
  <span class="font-mono tabular-nums" aria-live="polite">
    {#if shown === total}{total} {total === 1 ? "row" : "rows"}{:else}{shown} of {total} rows{/if}
  </span>

  {#if activeFilters > 0}
    <span aria-hidden="true">·</span>
    <span>{activeFilters} {activeFilters === 1 ? "filter" : "filters"} active</span>
    <button
      type="button"
      class="text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
      onclick={onclearFilters}
    >Clear</button>
  {/if}

  {#if namespaceHidden}
    <span aria-hidden="true">·</span>
    <span class="truncate">Namespace column hidden — one namespace selected</span>
  {/if}

  <span class="flex-1"></span>

  {#if updatedLabel}
    <span class="shrink-0 font-mono tabular-nums">{updatedLabel}</span>
  {/if}
</footer>
