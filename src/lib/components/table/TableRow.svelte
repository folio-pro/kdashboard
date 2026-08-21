<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import { cn } from "$lib/utils";
  import type { Resource, Column, TableDensity } from "$lib/types";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { metricsStore } from "$lib/stores/metrics.svelte";
  import { extensions } from "$lib/extensions";
  import { KIND_TO_RESOURCE_TYPE } from "$lib/resource-catalog";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import {
    getCellValue,
    isContainersColumn,
    isMonoColumn,
    isRightAlignedColumn,
    isStatusColumn,
    isTagColumn,
    isUsageColumn,
  } from "./cell-values";
  import { statusCategory, statusColor, isQuietStatus, rowSeverity } from "./status-category";
  import { splitPodName } from "./table-filter";
  import { ROW_HEIGHT, DENSITY_CLASSES } from "./table-density";
  import ContainersCell from "./ContainersCell.svelte";
  import UsageCell from "./UsageCell.svelte";
  import RowActions from "./RowActions.svelte";

  interface Props {
    resource: Resource;
    columns: Column[];
    selected: boolean;
    highlighted: boolean;
    resourceType: string;
    onclick: () => void;
    /** Double-click: open the row in its own tab (single click previews it). */
    ondblclick?: () => void;
    oncontextmenu?: (event: MouseEvent) => void;
    /** Open the row's action menu at a screen position (the "…" button). */
    onmore?: (x: number, y: number) => void;
    density: TableDensity;
    checkboxChecked?: boolean;
    /** True while any row in the table is checked: keeps every checkbox visible. */
    selectionActive?: boolean;
    oncheck?: () => void;
  }

  let {
    resource, columns, selected, highlighted, resourceType, onclick, ondblclick, oncontextmenu, onmore,
    density, checkboxChecked = false, selectionActive = false, oncheck,
  }: Props = $props();

  let d = $derived(DENSITY_CLASSES[density]);

  let trailingMounts = $derived(
    extensions.mountsFor("table-row-trailing").filter((m) => !m.visible || m.visible()),
  );

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

  // Pods: the generated suffix is dimmed so the owner's name is what the eye
  // reads down the column. Other kinds keep their name whole.
  let podName = $derived(resourceType === "pods" ? splitPodName(resource.metadata.name) : null);

  // Row severity comes from the status cell: a 2px bar in the gutter for
  // problem rows only, so a scroll through 300 pods lands on the red ones.
  let statusValue = $derived(
    columns.some((c) => isStatusColumn(c.key)) ? getCellValue(resource, "status", cellCtx) : "-",
  );
  let severity = $derived(statusValue === "-" ? null : rowSeverity(statusCategory(statusValue)));

  // Events: the Object column deep-links to the involved resource when its
  // Kind is one the catalog can navigate to (built-in kinds only — a CRD kind
  // renders as plain text).
  let eventObjectTarget = $derived.by(() => {
    if (resourceType !== "events") return null;
    const ref = resource.spec?.involvedObject as
      | { kind?: string; name?: string; namespace?: string }
      | undefined;
    if (!ref?.kind || !ref.name) return null;
    const type = KIND_TO_RESOURCE_TYPE[ref.kind];
    if (!type) return null;
    return { type, name: ref.name, namespace: ref.namespace ?? resource.metadata.namespace ?? undefined };
  });

  let lastColumnIndex = $derived(columns.length - 1);
</script>

<tr
  class={cn(
    "group cursor-pointer border-b border-[var(--hairline)] transition-colors",
    d.mono && "font-mono",
    selected
      ? "bg-[var(--accent)]/10"
      : highlighted
        ? "bg-[var(--accent)]/[0.07]"
        : "hover:bg-[var(--table-row-hover)]"
  )}
  style="height: {ROW_HEIGHT[density]}px;"
  onclick={onclick}
  ondblclick={ondblclick}
  oncontextmenu={oncontextmenu}
  tabindex={highlighted ? 0 : -1}
  aria-selected={selected || highlighted}
  data-testid="resource-row"
  data-selected={selected || checkboxChecked ? "true" : undefined}
>
  <!-- Gutter: severity bar + checkbox. The checkbox only shows on hover or
       once a selection exists, so an unselected table has no column of empty
       boxes; the bar is the first thing the eye meets on a problem row. -->
  <td class="relative w-7 p-0 text-center" onclick={(e) => e.stopPropagation()}>
    {#if highlighted}
      <span class="absolute inset-y-0 left-0 w-0.5 bg-[var(--accent)]" aria-hidden="true"></span>
    {:else if severity}
      <span
        class="absolute inset-y-0 left-0 w-0.5"
        style:background-color={severity === "error"
          ? "var(--status-failed)"
          : "color-mix(in srgb, var(--status-pending) 55%, transparent)"}
        aria-hidden="true"
      ></span>
    {/if}
    {#if oncheck}
      <span
        class={cn(
          "inline-flex items-center justify-center align-middle transition-opacity",
          checkboxChecked || selectionActive
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 [&:has(:focus-visible)]:opacity-100"
        )}
      >
        <Checkbox checked={checkboxChecked} onCheckedChange={oncheck} aria-label="Select row" data-testid="row-checkbox" />
      </span>
    {/if}
  </td>
  {#each columns as column, ci}
    <td
      class={cn("relative overflow-hidden px-3.5", d.text, isRightAlignedColumn(column.key) && "text-right")}
      data-testid="cell-{column.key}"
    >
      {#if isContainersColumn(column.key)}
        <ContainersCell {resource} {density} />
      {:else if isUsageColumn(column.key)}
        <UsageCell {resource} columnKey={column.key} ctx={cellCtx} />
      {:else if isStatusColumn(column.key)}
        {@const val = getCellValue(resource, column.key, cellCtx)}
        {#if val === "-"}
          <span class="text-[var(--text-muted)]">-</span>
        {:else}
          {@const category = statusCategory(val)}
          {#if isQuietStatus(category)}
            <!-- Healthy / finished: plain muted text. Colour is reserved for
                 rows that need a look. -->
            <span class="block truncate text-[var(--text-muted)]" title={val}>{val}</span>
          {:else if d.pill}
            <span
              class="inline-flex max-w-full items-center gap-1.5 truncate rounded-sm px-1.5 text-[11px] font-medium leading-4"
              style="color: {statusColor(category)}; background-color: color-mix(in srgb, {statusColor(category)} 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, {statusColor(category)} 25%, transparent);"
              title={val}
            >
              <span class="h-[5px] w-[5px] shrink-0 rounded-full" style="background-color: {statusColor(category)}"></span>
              <span class="truncate">{val}</span>
            </span>
          {:else}
            <span class="block truncate font-medium" style="color: {statusColor(category)}" title={val}>{val}</span>
          {/if}
        {/if}
      {:else if column.key === "restarts"}
        {@const restarts = parseInt(getCellValue(resource, "restarts", cellCtx), 10) || 0}
        <span
          class={cn("font-mono tabular-nums", restarts > 5 && "font-medium")}
          style:color={restarts > 5
            ? "var(--status-failed)"
            : restarts > 0
              ? "var(--status-pending)"
              : "color-mix(in srgb, var(--text-muted) 55%, var(--bg-primary))"}
        >{restarts}</span>
      {:else if column.key === "eventObject" && eventObjectTarget}
        {@const label = getCellValue(resource, column.key, cellCtx)}
        {@const target = eventObjectTarget}
        <button
          type="button"
          class="block max-w-full truncate font-mono text-[var(--accent)] hover:underline"
          title={label}
          onclick={(e) => {
            e.stopPropagation();
            void openRelatedResourceTab(target.type, target.name, target.namespace);
          }}
        >{label}</button>
      {:else if isTagColumn(column.key)}
        {@const tagValue = getCellValue(resource, column.key, cellCtx)}
        {#if tagValue && tagValue !== "-" && tagValue !== "<none>"}
          <Badge appearance="surface" size="sm" bordered mono class="max-w-full truncate px-1.5" title={tagValue}>{tagValue}</Badge>
        {:else}
          <span class="text-[var(--text-muted)]">—</span>
        {/if}
      {:else if column.key === "name"}
        {@const cellValue = getCellValue(resource, column.key, cellCtx)}
        <span class="block truncate font-medium text-[var(--text-primary)]" title={cellValue}>
          {#if uiStore.filter}
            {@const idx = nameLower.indexOf(uiStore.filterLower)}
            {#if idx >= 0}{cellValue.slice(0, idx)}<span style="color:var(--accent)">{cellValue.slice(idx, idx + uiStore.filter.length)}</span>{cellValue.slice(idx + uiStore.filter.length)}{:else}{cellValue}{/if}
          {:else if podName && podName.suffix}
            {podName.base}<span class="font-normal text-[var(--text-muted)]">{podName.suffix}</span>
          {:else}
            {cellValue}
          {/if}
        </span>
      {:else}
        {@const cellValue = getCellValue(resource, column.key, cellCtx)}
        <span
          class={cn(
            "block truncate text-[var(--text-secondary)]",
            isMonoColumn(column.key) && "font-mono tabular-nums",
            column.key === "namespace" && "text-[var(--text-muted)]",
            column.key === "node" && "font-mono text-[11px] text-[var(--text-muted)]"
          )}
          title={cellValue}
        >{cellValue}</span>
      {/if}

      {#if ci === lastColumnIndex && onmore}
        <RowActions {resource} {resourceType} {onmore} />
      {/if}
    </td>
  {/each}
  {#each trailingMounts as mount (mount.id)}
    <mount.component {resource} />
  {/each}
</tr>
