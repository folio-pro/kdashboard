<script lang="ts">
  import { uiStore } from "$lib/stores/ui.svelte";
  import { healthTicks, type WorkloadStat, type HealthSegment } from "$lib/utils/workload-stats";
  import { Skeleton } from "$lib/components/ui/skeleton";

  /**
   * One 36px strip. A tick per object, grouped by state, so the strip counts
   * real things and still reads as a proportion; past what ticks can show it
   * falls back to the proportional bar. Empty states don't render, so anything
   * visible is something that exists.
   */
  interface Props {
    stats: WorkloadStat[];
    healthSegments: HealthSegment[];
    isLoading: boolean;
    hasError: boolean;
  }

  let { stats, healthSegments, isLoading, hasError }: Props = $props();

  let total = $derived(stats.find((s) => s.key === "total"));
  let healthTotal = $derived(healthSegments.reduce((sum, seg) => sum + seg.value, 0));
  let ticks = $derived(healthTicks(healthSegments));
  let healthLabel = $derived(
    healthSegments
      .filter((s) => s.value > 0)
      .map((s) => `${s.value} ${s.key}`)
      .join(", "),
  );

  // Everything except the total, which the "N pods" label already states, and
  // anything at zero — a status with no members is not news.
  let chips = $derived(stats.filter((s) => s.key !== "total" && s.value > 0));

  function formatValue(value: number): string {
    return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : value.toString();
  }
</script>

{#if isLoading}
  <div class="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border-color)] px-6">
    <Skeleton class="h-4 w-[120px] rounded-sm" />
    <Skeleton class="h-3 w-16" />
    <Skeleton class="h-3 w-20" />
    <Skeleton class="h-3 w-20" />
  </div>
{:else if !hasError && stats.length > 0}
  <div class="flex h-9 shrink-0 items-center gap-4 overflow-hidden border-b border-[var(--border-color)] px-6 text-[12px]">
    {#if ticks}
      <div class="flex shrink-0 gap-0.5" role="img" aria-label={healthLabel}>
        {#each ticks as color, i (i)}
          <span class="h-4 w-2 rounded-[2px]" style:background-color={color}></span>
        {/each}
      </div>
    {:else if healthTotal > 0}
      <div class="flex h-2 w-[240px] shrink-0 overflow-hidden rounded-[2px] bg-[var(--bg-tertiary)]" role="img" aria-label={healthLabel}>
        {#each healthSegments as seg (seg.key)}
          {#if seg.value > 0}
            <div class="h-full" style="width: {(seg.value / healthTotal) * 100}%; background-color: {seg.color};"></div>
          {/if}
        {/each}
      </div>
    {/if}

    <div class="flex min-w-0 items-center gap-3">
      {#if total}
        <span class="shrink-0 text-[var(--text-secondary)]">
          <span class="font-mono tabular-nums text-[var(--text-primary)]">{formatValue(total.value)}</span>
          {total.subtitle ?? ""}
        </span>
      {/if}

      {#each chips as stat (stat.key)}
        {@const isActive = uiStore.statFilter === stat.key}
        <button
          class="stat"
          class:stat-active={isActive}
          class:stat-clickable={stat.filterable}
          disabled={!stat.filterable}
          aria-pressed={stat.filterable ? isActive : undefined}
          onclick={() => uiStore.toggleStatFilter(stat.key)}
          title={!stat.filterable
            ? undefined
            : isActive
              ? `Showing only ${stat.label} — click to clear`
              : `Show only ${stat.label}`}
        >
          <span class="stat-dot" style:background-color={stat.color}></span>
          <span class="font-mono tabular-nums text-[var(--text-primary)]">{formatValue(stat.value)}</span>
          {stat.label}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--text-secondary);
    transition: color 0.15s;
  }
  .stat-clickable {
    cursor: pointer;
  }
  .stat-clickable:hover {
    color: var(--text-primary);
  }
  /* The active stat IS the "filtered by" indicator. */
  .stat-active {
    color: var(--text-primary);
    font-weight: 500;
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .stat-dot {
    height: 6px;
    width: 6px;
    flex-shrink: 0;
    border-radius: 9999px;
  }
</style>
