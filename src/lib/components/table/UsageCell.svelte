<script lang="ts">
  import type { Resource } from "$lib/types";
  import { usageMeter, usagePercentIsLoud, type CellContext } from "./cell-values";
  import { usageBarColor } from "$lib/stores/metrics.logic";

  /**
   * One line: value · bar · percent. The bar is neutral until it is telling
   * you something (amber from 70%, red from 90%); the percent label takes the
   * bar's colour at the same thresholds.
   */
  interface Props {
    resource: Resource;
    columnKey: string;
    ctx: CellContext;
  }

  let { resource, columnKey, ctx }: Props = $props();
  let usage = $derived(usageMeter(resource, columnKey, ctx));
</script>

<div class="flex items-center gap-2 font-mono text-[11px] leading-none tabular-nums" title={usage?.title ?? ""}>
  {#if usage}
    <span class="w-[42px] shrink-0 truncate text-[var(--text-secondary)]">{usage.label}</span>
    {#if usage.percent !== null}
      <span class="h-[3px] w-[46px] shrink-0 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <span
          class="block h-full rounded-full transition-[width] duration-300"
          style="width: {Math.min(usage.percent, 100)}%; background-color: {usageBarColor(usage.percent)}"
        ></span>
      </span>
      <span
        class="shrink-0"
        style:color={usagePercentIsLoud(usage.percent) ? usageBarColor(usage.percent) : "var(--text-muted)"}
      >{usage.percent}%</span>
    {:else if usage.basisLabel}
      <span class="truncate text-[var(--text-muted)]">/ {usage.basisLabel}</span>
    {/if}
  {:else}
    <span class="text-[var(--text-muted)]">—</span>
  {/if}
</div>
