<script lang="ts">
  import { uiStore } from "$lib/stores/ui.svelte";
  import type { WorkloadStat, HealthSegment } from "$lib/utils/workload-stats";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { AlertTriangle } from "lucide-svelte";

  /**
   * One 34px strip, where this used to be a ~125px band of five equal cards
   * plus a separate "Filtered by" pill row.
   *
   * The cards gave every status the same visual weight regardless of value, so
   * a healthy namespace spent most of the band rendering large zeros — the
   * states that matter (Failing, Pending, Attention) looked exactly as
   * important as the ones that didn't. Here the health bar carries the
   * proportions and empty states simply don't render, so anything visible is
   * something that exists.
   */
  interface Props {
    stats: WorkloadStat[];
    healthSegments: HealthSegment[];
    isLoading: boolean;
    hasError: boolean;
    needsAttention?: number;
  }

  let { stats, healthSegments, isLoading, hasError, needsAttention = 0 }: Props = $props();

  let total = $derived(stats.find((s) => s.key === "total"));
  let healthTotal = $derived(healthSegments.reduce((sum, seg) => sum + seg.value, 0));

  // Everything except the total, which the "N pods" label already states, and
  // anything at zero — a status with no members is not news.
  let chips = $derived(stats.filter((s) => s.key !== "total" && s.value > 0));

  function formatValue(value: number): string {
    return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : value.toString();
  }
</script>

{#if isLoading}
  <div class="flex h-[34px] shrink-0 items-center gap-3 px-6">
    <Skeleton class="h-1.5 w-[120px] rounded-full" />
    <Skeleton class="h-3 w-16" />
    <Skeleton class="h-3 w-20" />
    <Skeleton class="h-3 w-20" />
  </div>
{:else if !hasError && stats.length > 0}
  <div class="flex h-[34px] shrink-0 items-center gap-3 px-6">
    {#if healthTotal > 0}
      <div
        class="flex h-1.5 w-[120px] shrink-0 overflow-hidden rounded-full bg-[var(--border-color)]"
        role="img"
        aria-label={healthSegments
          .filter((s) => s.value > 0)
          .map((s) => `${s.value} ${s.key}`)
          .join(", ")}
      >
        {#each healthSegments as seg (seg.key)}
          {#if seg.value > 0}
            <div
              class="h-full transition-[width] duration-300"
              style="width: {(seg.value / healthTotal) * 100}%; background-color: {seg.color};"
            ></div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if total}
      <span class="shrink-0 text-[12px] font-medium tabular-nums text-[var(--text-primary)]">
        {formatValue(total.value)}
        <span class="font-normal text-[var(--text-muted)]">{total.subtitle ?? ""}</span>
      </span>
    {/if}

    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
      {#each chips as stat (stat.key)}
        {@const isActive = uiStore.statFilter === stat.key}
        <button
          class="chip"
          class:chip-active={isActive}
          class:chip-clickable={stat.filterable}
          style:--chip-color={stat.color}
          disabled={!stat.filterable}
          aria-pressed={stat.filterable ? isActive : undefined}
          onclick={() => uiStore.toggleStatFilter(stat.key)}
          title={!stat.filterable
            ? undefined
            : isActive
              ? `Showing only ${stat.label} — click to clear`
              : `Show only ${stat.label}`}
        >
          <span class="chip-dot"></span>
          <span class="tabular-nums">{formatValue(stat.value)}</span>
          {stat.label}
        </button>
      {/each}

      {#if needsAttention > 0}
        {@const isActive = uiStore.statFilter === "needsAttention"}
        <button
          class="chip chip-clickable chip-attention"
          class:chip-active={isActive}
          style:--chip-color="var(--status-failed)"
          aria-pressed={isActive}
          onclick={() => uiStore.toggleStatFilter("needsAttention")}
          title={isActive
            ? "Showing only resources needing attention — click to clear"
            : "Show only resources needing attention"}
        >
          <AlertTriangle class="h-3 w-3" />
          <span class="tabular-nums">{formatValue(needsAttention)}</span>
          Attention
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
    border-radius: 9999px;
    border: 1px solid var(--border-color);
    background-color: var(--bg-secondary);
    padding: 0.125rem 0.5rem;
    font-size: 11px;
    color: var(--text-secondary);
    transition:
      border-color 0.15s,
      background-color 0.15s,
      color 0.15s;
  }
  .chip-clickable {
    cursor: pointer;
  }
  .chip-clickable:hover {
    border-color: var(--chip-color);
    color: var(--text-primary);
  }
  /* The active chip IS the "filtered by" indicator — it replaces the separate
     pill row that used to restate it on its own line. */
  .chip-active {
    border-color: var(--chip-color);
    background-color: color-mix(in srgb, var(--chip-color) 12%, var(--bg-secondary));
    color: var(--text-primary);
    font-weight: 500;
  }
  .chip-dot {
    height: 6px;
    width: 6px;
    flex-shrink: 0;
    border-radius: 9999px;
    background-color: var(--chip-color);
  }
  .chip-attention {
    color: var(--status-failed);
    border-color: color-mix(in srgb, var(--status-failed) 35%, var(--border-color));
  }
</style>
