<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Resource, Column } from "$lib/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Box } from "lucide-svelte";
  import { getContainerIconUrl } from "$lib/utils/container-icon";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { metricsStore } from "$lib/stores/metrics.svelte";
  import { extensions } from "$lib/extensions";
  import {
    getCellValue,
    isContainersColumn,
    isMonoColumn,
    isStatusColumn,
    isTagColumn,
    isUsageColumn,
    usageBarColor,
    usageMeter,
  } from "./cell-values";

  interface Props {
    resource: Resource;
    columns: Column[];
    selected: boolean;
    highlighted: boolean;
    resourceType: string;
    onclick: () => void;
    ondblclick?: () => void;
    oncontextmenu?: (event: MouseEvent) => void;
    density: "comfortable" | "compact";
    checkboxChecked?: boolean;
    oncheck?: () => void;
    ondblclickcopy?: (value: string) => void;
  }

  let { resource, columns, selected, highlighted, resourceType, onclick, ondblclick, oncontextmenu, density, checkboxChecked = false, oncheck, ondblclickcopy }: Props = $props();

  let trailingMounts = $derived(
    extensions.mountsFor("table-row-trailing").filter((m) => !m.visible || m.visible()),
  );

  let rowHeight = $derived(density === "compact" ? "h-8" : "h-11");

  // Everything the cell accessors need from the stores, gathered once per row
  // so cell-values.ts can stay a pure module.
  let cellCtx = $derived({
    ageTick: k8sStore.ageTick,
    nodeCost: costStore.getNodeCost(resource.metadata.name),
    nodeMetrics: costStore.getNodeMetrics(resource.metadata.name),
    podUsage: metricsStore.getPodUsage(resource.metadata.namespace, resource.metadata.name),
  });

  // Precompute the lowercased name once per row instead of re-lowercasing the
  // cell value inline on every render of the name-column filter highlight.
  let nameLower = $derived(resource.metadata.name.toLowerCase());

  let failedIcons: Set<string> = $state(new Set());

  type ContainerState = "running" | "waiting" | "error" | "terminated";

  interface ContainerInfo {
    name: string;
    ready: boolean;
    iconUrl: string | null;
    state: ContainerState;
  }

  let containerStatuses = $derived.by((): ContainerInfo[] => {
    const cs = resource.status?.containerStatuses as Array<{ name: string; ready: boolean; image: string; state?: Record<string, unknown> }> | undefined;
    if (!cs) return [];
    return cs.map((c) => {
      const img = c.image ?? "";
      const url = img ? getContainerIconUrl(img) : null;
      let state: ContainerState = "running";
      if (c.state) {
        if (c.state.waiting) {
          const reason = (c.state.waiting as { reason?: string }).reason ?? "";
          state = /error|crash|backoff/i.test(reason) ? "error" : "waiting";
        } else if (c.state.terminated) {
          const exitCode = (c.state.terminated as { exitCode?: number }).exitCode;
          state = exitCode && exitCode !== 0 ? "error" : "terminated";
        }
      }
      if (!c.ready && state === "running") state = "waiting";
      return {
        name: c.name,
        ready: c.ready,
        iconUrl: (url && !failedIcons.has(url)) ? url : null,
        state,
      };
    });
  });

  function containerStateColor(state: ContainerState): string {
    switch (state) {
      case "running": return "var(--status-running)";
      case "waiting": return "var(--status-pending)";
      case "error": return "var(--status-failed)";
      case "terminated": return "var(--text-muted)";
    }
  }

  function containerIconFilter(state: ContainerState): string {
    switch (state) {
      case "error": return "grayscale(1) brightness(0.7) sepia(1) hue-rotate(-30deg) saturate(5)";
      case "waiting": return "grayscale(1) brightness(0.9) sepia(1) hue-rotate(15deg) saturate(3)";
      default: return "none";
    }
  }

  function handleIconError(url: string) {
    if (failedIcons.has(url)) return;
    const next = new Set(failedIcons);
    next.add(url);
    failedIcons = next;
  }

  function handleCellDblClick(event: MouseEvent, key: string) {
    event.stopPropagation();
    const value = getCellValue(resource, key, cellCtx);
    if (!value || value === "-" || value === "<none>") return;

    const td = (event.target as HTMLElement).closest("td") as HTMLElement | null;

    navigator.clipboard.writeText(value).then(() => {
      if (td) {
        td.classList.add("cell-copied-flash");
        setTimeout(() => td.classList.remove("cell-copied-flash"), 600);
      }
      ondblclickcopy?.(value);
    }).catch(() => {
      // clipboard write failed silently
    });
  }
</script>

<style>
  :global(.cell-copied-flash) {
    animation: cellFlash 0.6s ease-out;
  }

  @keyframes cellFlash {
    0% {
      background-color: var(--accent);
      color: white;
    }
    100% {
      background-color: transparent;
    }
  }
</style>

<tr
  class={cn(
    "cursor-pointer border-b border-[var(--border-color)] transition-colors",
    rowHeight,
    selected
      ? "bg-[var(--accent)]/10"
      : highlighted
        ? "bg-[var(--accent)]/5 ring-1 ring-inset ring-[var(--accent)]/20"
        : "hover:bg-[var(--table-row-hover)]"
  )}
  onclick={onclick}
  ondblclick={ondblclick}
  oncontextmenu={oncontextmenu}
  tabindex={highlighted ? 0 : -1}
  aria-selected={selected || highlighted}
  role="row"
>
  {#if oncheck}
    <td class="w-10 px-4 text-center" onclick={(e) => e.stopPropagation()}>
      <Checkbox
        checked={checkboxChecked}
        onCheckedChange={oncheck}
        aria-label="Select row"
      />
    </td>
  {/if}
  {#each columns as column}
    <td
      class="overflow-hidden px-4 text-xs"
      ondblclick={(e) => handleCellDblClick(e, column.key)}
    >
      {#if isContainersColumn(column.key)}
        <div class="flex items-center gap-1.5 overflow-hidden">
          {#each containerStatuses as c}
            <div
              class="relative flex h-6 w-6 shrink-0 items-center justify-center rounded border"
              style:background-color={`color-mix(in srgb, ${containerStateColor(c.state)} 14%, var(--bg-tertiary))`}
              style:border-color={`color-mix(in srgb, ${containerStateColor(c.state)} 28%, transparent)`}
              title="{c.name} ({c.state})"
            >
              {#if c.iconUrl}
                <img
                  src={c.iconUrl}
                  alt={c.name}
                  class="h-4 w-4 object-contain"
                  style:filter={containerIconFilter(c.state)}
                  onerror={() => handleIconError(c.iconUrl!)}
                />
              {:else}
                <span style:color={containerStateColor(c.state)}><Box class="h-3.5 w-3.5" /></span>
              {/if}
            </div>
          {/each}
        </div>
      {:else if isUsageColumn(column.key)}
        {@const usage = usageMeter(resource, column.key, cellCtx)}
        <!-- Value above, meter below: the meter reads as "how full", the value
             as "how much", and the denominator says why the meter is that full.
             The empty track is kept when there is no data so the column does
             not visually jump between rows. -->
        <div class="flex w-full flex-col justify-center gap-1" title={usage?.title ?? ""}>
          <!-- The type size lives on this row, not on each span, so the used
               value and its denominator can never drift apart; the spans only
               carry colour. -->
          <div class="flex items-baseline gap-1.5 overflow-hidden font-mono text-[11.5px] leading-none tabular-nums">
            {#if usage}
              <span class="text-[var(--text-primary)]">{usage.label}</span>
              {#if usage.basisLabel}
                <span class="truncate text-[var(--text-dimmed)]">/ {usage.basisLabel}</span>
              {/if}
            {:else}
              <span class="text-[var(--text-muted)]">—</span>
            {/if}
          </div>
          <div class="h-[3px] w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            {#if usage && usage.percent !== null}
              <div
                class="h-full rounded-full transition-all duration-300"
                style="width: {Math.min(usage.percent, 100)}%; background-color: {usageBarColor(usage.percent)}"
              ></div>
            {/if}
          </div>
        </div>
      {:else if isStatusColumn(column.key)}
        {@const val = getCellValue(resource, "status", cellCtx)}
        {#if val !== "-"}
          <StatusBadge status={val} />
        {:else}
          <span class="text-[var(--text-muted)]">-</span>
        {/if}
      {:else if column.key === "restarts"}
        {@const restarts = parseInt(getCellValue(resource, "restarts", cellCtx), 10) || 0}
        <span
          class={cn(
            "font-mono text-[12px] tabular-nums",
            restarts > 5
              ? "font-medium text-[var(--status-failed)]"
              : restarts > 0
                ? "font-medium text-[var(--status-pending)]"
                : "text-[var(--text-muted)]"
          )}
        >{restarts}</span>
      {:else if isTagColumn(column.key)}
        {@const tagValue = getCellValue(resource, column.key, cellCtx)}
        {#if tagValue && tagValue !== "-" && tagValue !== "<none>"}
          <span class="inline-flex max-w-full items-center truncate rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]" title={tagValue}>{tagValue}</span>
        {:else}
          <span class="text-[var(--text-muted)]">—</span>
        {/if}
      {:else}
        {@const cellValue = getCellValue(resource, column.key, cellCtx)}
        <span
          class={cn(
            "block truncate text-[var(--text-secondary)]",
            isMonoColumn(column.key) && "font-mono text-[12px] tabular-nums text-[var(--text-secondary)]",
            column.key === "name" && "font-medium text-[var(--text-primary)]",
            column.key === "namespace" && "text-[var(--text-muted)]",
            column.key === "node" && "text-[11px] text-[var(--text-muted)]"
          )}
          title={cellValue}
        >
{#if column.key === "name" && uiStore.filter}{@const idx = nameLower.indexOf(uiStore.filterLower)}{#if idx >= 0}{cellValue.slice(0, idx)}<span style="color:var(--accent)">{cellValue.slice(idx, idx + uiStore.filter.length)}</span>{cellValue.slice(idx + uiStore.filter.length)}{:else}{cellValue}{/if}{:else}{cellValue}{/if}
        </span>
      {/if}
    </td>
  {/each}
  {#each trailingMounts as mount (mount.id)}
    <mount.component {resource} />
  {/each}
</tr>
