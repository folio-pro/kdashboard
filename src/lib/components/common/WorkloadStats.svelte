<script lang="ts">
  import { tweened, type Tweened } from "svelte/motion";
  import { cubicOut } from "svelte/easing";
  import { onDestroy } from "svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import type { WorkloadStat, HealthSegment } from "$lib/utils/workload-stats";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { AlertTriangle } from "lucide-svelte";

  interface Props {
    stats: WorkloadStat[];
    healthSegments: HealthSegment[];
    isLoading: boolean;
    hasError: boolean;
    skeletonCount?: number;
    needsAttention?: number;
  }

  let { stats, healthSegments, isLoading, hasError, skeletonCount = 4, needsAttention = 0 }: Props = $props();

  // Animated counter — one tweened store per stat key, managed via $effect
  let animatedValues: Record<string, number> = $state({});
  let tweenStores: Record<string, Tweened<number>> = {};
  let unsubs: Array<() => void> = [];
  let prevKeys = "";

  $effect(() => {
    const keys = stats.map((s) => s.key).join(",");

    if (keys !== prevKeys) {
      for (const unsub of unsubs) unsub();
      unsubs = [];
      tweenStores = {};
      for (const key of Object.keys(animatedValues)) delete animatedValues[key];
      for (const s of stats) {
        const store = tweened(s.value, { duration: 400, easing: cubicOut });
        tweenStores[s.key] = store;
        animatedValues[s.key] = s.value;
        unsubs.push(store.subscribe((v: number) => { animatedValues[s.key] = Math.round(v); }));
      }
      prevKeys = keys;
    } else {
      for (const s of stats) {
        tweenStores[s.key]?.set(s.value);
      }
    }
  });

  // Needs attention tweened value
  let animatedAttention = $state(0);
  let attentionStore: Tweened<number> | null = null;
  let attentionUnsub: (() => void) | null = null;
  $effect(() => {
    if (needsAttention > 0) {
      if (!attentionStore) {
        attentionStore = tweened(needsAttention, { duration: 400, easing: cubicOut });
        attentionUnsub = attentionStore.subscribe((v: number) => { animatedAttention = Math.round(v); });
      } else {
        attentionStore.set(needsAttention);
      }
    } else {
      attentionUnsub?.();
      attentionUnsub = null;
      attentionStore = null;
      animatedAttention = 0;
    }
  });

  onDestroy(() => {
    for (const unsub of unsubs) unsub();
    attentionUnsub?.();
  });

  let totalValue = $derived(stats.find((s) => s.key === "total")?.value ?? 0);
  let healthTotal = $derived(healthSegments.reduce((sum, seg) => sum + seg.value, 0));

  function handleCardClick(stat: WorkloadStat) {
    if (!stat.filterable) return;
    uiStore.toggleStatFilter(stat.key);
  }

  function formatValue(value: number): string {
    if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
    return value.toString();
  }
</script>

{#if isLoading}
  <div class="flex items-stretch gap-2.5 px-6 pt-3.5 pb-3">
    {#each Array(skeletonCount) as _}
      <div class="flex flex-1 flex-col gap-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3.5">
        <div class="flex items-center gap-2">
          <Skeleton class="h-2 w-2 rounded-full" />
          <Skeleton class="h-3 w-14" />
        </div>
        <Skeleton class="h-7 w-10" />
        <Skeleton class="h-1.5 w-full rounded-full" />
      </div>
    {/each}
  </div>
{:else if !hasError && stats.length > 0}
  <div class="flex items-stretch gap-2.5 px-6 pt-3.5 pb-3">
    {#each stats as stat (stat.key)}
      {@const isActive = uiStore.statFilter === stat.key}
      {@const displayValue = animatedValues[stat.key] ?? stat.value}
      {@const isEmpty = stat.value === 0}
      <button
        class="stat-card group flex flex-1 flex-col rounded-lg border text-left transition-all duration-200"
        class:stat-card-active={isActive}
        class:stat-card-clickable={stat.filterable}
        style:--card-color={stat.color}
        onclick={() => handleCardClick(stat)}
        disabled={!stat.filterable}
        title={stat.filterable ? (isActive ? "Click to clear filter" : `Filter by ${stat.label}`) : ""}
      >
        <div class="flex flex-col gap-1 p-3.5">
          <!-- Label row with colored dot -->
          <div class="flex items-center gap-1.5">
            <div
              class="h-[7px] w-[7px] shrink-0 rounded-full transition-all duration-200"
              style:background-color={isEmpty ? 'var(--text-dimmed)' : stat.color}
              style:box-shadow={!isEmpty && stat.value > 0 ? `0 0 6px ${stat.color}` : 'none'}
            ></div>
            <span class="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
              {stat.label}
            </span>
          </div>

          <!-- Value -->
          <div class="flex items-baseline gap-1.5">
            <span
              class="text-[22px] font-bold leading-none tabular-nums tracking-tight transition-colors duration-200"
              style:color={isEmpty ? 'var(--text-dimmed)' : stat.color}
            >
              {formatValue(displayValue)}
            </span>
            {#if stat.subtitle}
              <span class="text-[10px] text-[var(--text-dimmed)]">{stat.subtitle}</span>
            {/if}
          </div>

          <!-- Health bar on Total card / progress bar on others -->
          {#if stat.key === "total" && healthSegments.length > 0 && healthTotal > 0}
            <div class="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-color)]">
              {#each healthSegments as seg (seg.key)}
                {#if seg.value > 0}
                  <div
                    class="h-full transition-all duration-500"
                    style="width: {(seg.value / healthTotal) * 100}%; background-color: {seg.color};"
                  ></div>
                {/if}
              {/each}
            </div>
          {:else}
            <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-color)]">
              <div
                class="h-full rounded-full transition-all duration-300"
                style="width: {stat.value > 0 && totalValue > 0 ? Math.max(6, (stat.value / totalValue) * 100) : 0}%; background-color: {stat.color};"
              ></div>
            </div>
          {/if}
        </div>
      </button>
    {/each}

    <!-- Needs Attention card -->
    {#if needsAttention > 0}
      {@const isActive = uiStore.statFilter === "needsAttention"}
      <button
        class="stat-card stat-card-attention group flex flex-1 flex-col rounded-lg border text-left transition-all duration-200"
        class:stat-card-attention-active={isActive}
        onclick={() => uiStore.toggleStatFilter("needsAttention")}
        title={isActive ? "Click to clear filter" : "Filter by resources needing attention"}
      >
        <div class="flex flex-col gap-1 p-3.5">
          <div class="flex items-center gap-1.5">
            <AlertTriangle class="h-3 w-3 text-[var(--status-failed)]" />
            <span class="text-[10px] font-semibold tracking-wider text-[var(--status-failed)] uppercase">
              Attention
            </span>
          </div>
          <div class="flex items-baseline gap-1.5">
            <span class="text-[22px] font-bold leading-none tabular-nums tracking-tight text-[var(--status-failed)]">
              {formatValue(animatedAttention)}
            </span>
            <span class="text-[10px] text-[var(--text-dimmed)]">issues</span>
          </div>
          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-color)]">
            <div
              class="h-full rounded-full transition-all duration-300"
              style="width: {needsAttention > 0 && totalValue > 0 ? Math.max(6, (needsAttention / totalValue) * 100) : 0}%; background-color: var(--status-failed);"
            ></div>
          </div>
        </div>
      </button>
    {/if}
  </div>

  <!-- Active filter indicator -->
  {#if uiStore.statFilter}
    <div class="flex items-center gap-2 px-6 pb-2">
      <span class="text-[10px] text-[var(--text-muted)]">
        Filtered by:
      </span>
      <button
        class="stat-filter-pill"
        onclick={() => uiStore.clearStatFilter()}
      >
        {stats.find((s) => s.key === uiStore.statFilter)?.label ?? uiStore.statFilter}
        <span class="ml-0.5 opacity-60">&times;</span>
      </button>
    </div>
  {/if}
{/if}

<style>
  .stat-card {
    border-color: var(--border-color);
    background-color: var(--bg-secondary);
    cursor: default;
    overflow: hidden;
  }
  .stat-card-clickable {
    cursor: pointer;
  }
  .stat-card-clickable:hover {
    border-color: var(--card-color, var(--border-hover));
    background-color: color-mix(in srgb, var(--card-color, var(--accent)) 4%, var(--bg-secondary));
  }
  .stat-card-active {
    border-color: var(--card-color, var(--accent));
    background-color: color-mix(in srgb, var(--card-color, var(--accent)) 8%, var(--bg-secondary));
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--card-color, var(--accent)) 25%, transparent),
      0 2px 8px color-mix(in srgb, var(--card-color, var(--accent)) 15%, transparent);
  }
  .stat-card-attention {
    border-color: color-mix(in srgb, var(--status-failed) 30%, var(--border-color));
    background-color: var(--bg-secondary);
    cursor: pointer;
    overflow: hidden;
  }
  .stat-card-attention:hover {
    border-color: var(--status-failed);
    background-color: color-mix(in srgb, var(--status-failed) 4%, var(--bg-secondary));
  }
  .stat-card-attention-active {
    border-color: var(--status-failed);
    background-color: color-mix(in srgb, var(--status-failed) 8%, var(--bg-secondary));
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--status-failed) 25%, transparent),
      0 2px 8px color-mix(in srgb, var(--status-failed) 15%, transparent);
  }
  .stat-filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 9999px;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    background-color: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
    padding: 0.125rem 0.625rem;
    font-size: 10px;
    font-weight: 500;
    color: var(--accent);
    transition: background-color 0.15s;
  }
  .stat-filter-pill:hover {
    background-color: color-mix(in srgb, var(--accent) 15%, var(--bg-secondary));
  }
</style>
