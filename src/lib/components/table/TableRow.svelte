<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import { cn } from "$lib/utils";
  import type { Resource, Column, TableDensity } from "$lib/types";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { metricsStore } from "$lib/stores/metrics.svelte";
  import { endpointsStore } from "$lib/stores/endpoints.svelte";
  import { extensions } from "$lib/extensions";
  import { KIND_TO_RESOURCE_TYPE } from "$lib/resource-catalog";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import {
    autoscalerPressure,
    getCellValue,
    isAutoscalerTargetsColumn,
    isContainersColumn,
    isMonoColumn,
    isRightAlignedColumn,
    isStatusColumn,
    isTagColumn,
    isUsageColumn,
    statusDetail,
  } from "./cell-values";
  import { podReadyCount, podRestarts } from "$lib/utils/pod-status";
  import { replicaSegments, shortImage, templateImages } from "$lib/utils/workload-status";
  import { serviceExternal } from "$lib/utils/service-info";
  import { formatAge } from "$lib/utils/age";
  import ReplicaBar from "$lib/components/common/ReplicaBar.svelte";
  import { statusCategory, statusColor, isQuietStatus, rowSeverity } from "./status-category";
  import { splitPodName } from "./table-filter";
  import { ROW_HEIGHT, DENSITY_CLASSES } from "./table-density";
  import ContainersCell from "./ContainersCell.svelte";
  import UsageCell from "./UsageCell.svelte";
  import RowActions from "./RowActions.svelte";
  import { usageBarColor } from "$lib/stores/metrics.logic";
  import { autoscalerFlavor, autoscalerSummary } from "$lib/utils/autoscaler";
  import { liveValues, NO_FLASH } from "$lib/stores/live-values.svelte";

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

  // Non-null only on the three autoscaler tables; everywhere else it short
  // circuits the normalizing and the flash lookups below.
  let flavor = $derived(autoscalerFlavor(resourceType));

  // Everything the cell accessors need from the stores, gathered once per row
  // so cell-values.ts can stay a pure module.
  // Each lookup is gated on the table that reads it: a row subscribes to the
  // node-cost / pod-usage records it would otherwise never render, and every
  // metrics poll re-ran every cell of every visible row on every table.
  let cellCtx = $derived({
    ageTick: k8sStore.ageTick,
    nodeCost: resourceType === "nodes" ? costStore.getNodeCost(resource.metadata.name) : undefined,
    nodeMetrics: resourceType === "nodes" ? costStore.getNodeMetrics(resource.metadata.name) : undefined,
    podUsage: resourceType === "pods"
      ? metricsStore.getPodUsage(resource.metadata.namespace, resource.metadata.name)
      : undefined,
    autoscaler: flavor ? autoscalerSummary(resource, flavor) : undefined,
    endpoints: resourceType === "services"
      ? endpointsStore.summaryFor(resource.metadata.namespace, resource.metadata.name)
      : undefined,
  });

  // Which of this row's values moved on the last watch delta. Bailing out
  // before rowFlash() is deliberate: rowFlash subscribes to the store, so a row
  // on any other table must not call it — otherwise a flash on the autoscaler
  // table re-renders the pods table behind it.
  let flashes = $derived(
    flavor ? liveValues.rowFlash(resource.metadata.uid, Date.now()) : NO_FLASH,
  );

  /** Rising pressure is the direction that costs money, so it takes the warn
   *  tone; falling takes the healthy one. */
  function flashColor(direction: "up" | "down"): string {
    return direction === "up" ? "var(--status-pending)" : "var(--status-running)";
  }

  // Precompute the lowercased name once per row instead of re-lowercasing the
  // cell value inline on every render of the name-column filter highlight.
  let nameLower = $derived(resource.metadata.name.toLowerCase());

  // Pods: the generated suffix is dimmed so the owner's name is what the eye
  // reads down the column. Other kinds keep their name whole.
  let podName = $derived(resourceType === "pods" ? splitPodName(resource.metadata.name) : null);

  // Row severity comes from the status cell: a 2px bar in the gutter for
  // problem rows only, so a scroll through 300 pods lands on the red ones.
  // The table says which column is its status (Events use `eventType`), so the
  // gutter reads that one rather than assuming "status".
  let statusColumn = $derived(columns.find((c) => isStatusColumn(c.key)));
  let statusValue = $derived(statusColumn ? getCellValue(resource, statusColumn.key, cellCtx) : "-");
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

  // The checkbox and the hover actions are invisible until the pointer is on
  // the row (or it is keyboard-highlighted / part of a selection), yet they
  // were mounted for every virtual row: a bits-ui checkbox plus two to four
  // Buttons with lucide icons, i.e. most of the cost of creating a row — which
  // is what scrolling does, tens of times per frame. Mount them on demand.
  let hovered = $state(false);
  let showChrome = $derived(hovered || highlighted || checkboxChecked || selectionActive);
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
  onpointerenter={() => (hovered = true)}
  onpointerleave={() => (hovered = false)}
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
    {#if oncheck && showChrome}
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
      {:else if isAutoscalerTargetsColumn(column.key)}
        {@const pressure = autoscalerPressure(cellCtx.autoscaler)}
        <!-- Same shape as a usage meter, because it answers the same question:
             the reading above, and how close it is to the number that makes the
             autoscaler act below. The arrow only appears for the moment after
             the value moved, which is what makes a live table readable. -->
        <div class="flex w-full flex-col justify-center gap-1" title={pressure?.title ?? ""}>
          <div class="flex items-baseline gap-1 overflow-hidden font-mono text-[11px] leading-none tabular-nums">
            {#if pressure}
              <!-- Name elastic, reading pinned: an external metric name
                   ("nginx.net.request_per_s") is long enough to push the
                   numbers off the end of the cell otherwise. -->
              {#each pressure.parts as part, i (`${i}:${part.name}`)}
                <!-- The separator rides on the value rather than being its own
                     element, so the flex gap cannot open a space before it. -->
                <span class="truncate text-[var(--text-muted)]">{part.name}:</span>
                <span class={cn("shrink-0 text-[var(--text-primary)]", flashes.targets && "animate-value-flash")}
                  >{part.value}{i < pressure.parts.length - 1 ? "," : ""}</span>
              {/each}
              {#if flashes.targets}
                <span class="shrink-0 leading-none" style:color={flashColor(flashes.targets)}>
                  {flashes.targets === "up" ? "\u25b2" : "\u25bc"}
                </span>
              {/if}
            {:else}
              <span class="text-[var(--text-muted)]">&mdash;</span>
            {/if}
          </div>
          {#if pressure?.meter}
            <div class="relative h-[3px] w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              {#if pressure.percent !== null}
                <div
                  class="h-full rounded-full transition-all duration-300"
                  style="width: {Math.min(pressure.percent, 100)}%; background-color: {usageBarColor(pressure.percent)}"
                ></div>
              {/if}
              {#if pressure.lowPercent !== null}
                <!-- A watermark autoscaler does nothing between its two marks;
                     the tick is where "too low, scale down" begins. -->
                <div
                  class="absolute inset-y-0 w-px bg-[var(--text-muted)]"
                  style="left: {Math.min(pressure.lowPercent, 100)}%"
                ></div>
              {/if}
            </div>
          {/if}
        </div>
      {:else if column.key === "autoscalerReplicas"}
        {@const replicas = getCellValue(resource, column.key, cellCtx)}
        <span class="flex items-baseline gap-1 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">
          <span class={cn(flashes.replicas && "animate-value-flash", replicas.includes("\u2192") && "text-[var(--status-pending)]")}>{replicas}</span>
          {#if flashes.replicas}
            <span class="shrink-0 leading-none" style:color={flashColor(flashes.replicas)}>
              {flashes.replicas === "up" ? "\u25b2" : "\u25bc"}
            </span>
          {/if}
        </span>
      {:else if column.key === "podReady"}
        <!-- Tiles say which container; the fraction says how many. Amber when
             not every container is ready, so a 1/2 stands out from a 2/2. -->
        {@const ready = podReadyCount(resource)}
        <div class="flex items-center gap-2 overflow-hidden">
          <ContainersCell {resource} {density} />
          <span
            class="shrink-0 font-mono tabular-nums"
            style:color={ready.total > 0 && ready.ready < ready.total ? "var(--status-pending)" : "var(--text-secondary)"}
          >{ready.ready}/{ready.total}</span>
        </div>
      {:else if column.key === "deployReady"}
        {@const seg = replicaSegments(resource)}
        <div class="flex items-center gap-2.5 overflow-hidden">
          <span
            class="shrink-0 font-mono tabular-nums"
            style:color={seg.ready < seg.desired ? "var(--status-pending)" : "var(--text-secondary)"}
          >{seg.ready}/{seg.desired}</span>
          <ReplicaBar ready={seg.ready} pending={seg.pending} missing={seg.missing} />
        </div>
      {:else if column.key === "images"}
        {@const images = templateImages(resource)}
        {#if images.length === 0}
          <span class="text-[var(--text-muted)]">—</span>
        {:else}
          <div class="flex items-center gap-1.5 overflow-hidden">
            {#each images.slice(0, 2) as image (image)}
              <Badge appearance="surface" size="sm" bordered mono class="max-w-[220px] truncate px-1.5" title={image}>{shortImage(image)}</Badge>
            {/each}
            {#if images.length > 2}
              <Badge appearance="surface" size="sm" bordered mono class="px-1.5" title={images.slice(2).join(", ")}>+{images.length - 2}</Badge>
            {/if}
          </div>
        {/if}
      {:else if column.key === "endpoints"}
        {@const summary = cellCtx.endpoints}
        {#if summary === undefined}
          <!-- Slices not loaded yet: blank rather than a wrong zero. -->
          <span></span>
        {:else if summary === null}
          <span class="text-[var(--text-muted)]" title="No EndpointSlice for this service">—</span>
        {:else if summary.total === 0}
          <span class="inline-flex items-center gap-1.5" title="No endpoints: nothing backs this service">
            <span class="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--status-failed)]"></span>
            <span class="font-mono tabular-nums text-[var(--status-failed)]">0</span>
            <span class="truncate text-[11px] text-[var(--status-failed)]">no backends</span>
          </span>
        {:else}
          <span
            class="font-mono tabular-nums"
            style:color={summary.ready < summary.total ? "var(--status-pending)" : "var(--text-secondary)"}
            title="{summary.ready} ready of {summary.total}{summary.terminating ? ` · ${summary.terminating} terminating` : ''}"
          >{summary.ready}/{summary.total}</span>
        {/if}
      {:else if column.key === "externalIP"}
        {@const external = serviceExternal(resource)}
        {#if external.label}
          <span class="block truncate font-mono tabular-nums text-[var(--text-secondary)]" title={external.label}>{external.label}</span>
        {:else if external.pending}
          <span class="inline-flex max-w-full items-center gap-1.5 overflow-hidden" title="LoadBalancer has no address yet">
            <span
              class="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium leading-4"
              style="color: var(--status-pending); background-color: color-mix(in srgb, var(--status-pending) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--status-pending) 25%, transparent);"
            >
              <span class="h-[5px] w-[5px] rounded-full bg-[var(--status-pending)]"></span>Pending
            </span>
            <span class="truncate text-[11px] text-[var(--text-muted)]">no address yet</span>
          </span>
        {:else}
          <span class="text-[var(--text-muted)]">—</span>
        {/if}
      {:else if column.key === "controlledBy"}
        {@const owner = getCellValue(resource, column.key, cellCtx)}
        {#if owner === "-"}
          <span class="text-[var(--text-muted)]">—</span>
        {:else}
          {@const slash = owner.indexOf("/")}
          <span class="flex items-center gap-1.5 overflow-hidden" title={owner}>
            <span class="shrink-0 text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">{owner.slice(0, slash)}</span>
            <span class="truncate font-mono text-[11px] text-[var(--text-secondary)]">{owner.slice(slash + 1)}</span>
          </span>
        {/if}
      {:else if isStatusColumn(column.key)}
        {@const val = getCellValue(resource, column.key, cellCtx)}
        {@const detail = statusDetail(resource, column.key)}
        {#if val === "-"}
          <span class="text-[var(--text-muted)]">-</span>
        {:else}
          {@const category = statusCategory(val)}
          <span class="flex items-center gap-1.5 overflow-hidden">
          {#if isQuietStatus(category)}
            <!-- Healthy / finished: plain muted text. Colour is reserved for
                 rows that need a look. -->
            <span class="truncate text-[var(--text-muted)]" title={val}>{val}</span>
          {:else if d.pill}
            <span
              class="inline-flex max-w-full shrink-0 items-center gap-1.5 truncate rounded-sm px-1.5 text-[11px] font-medium leading-4"
              style="color: {statusColor(category)}; background-color: color-mix(in srgb, {statusColor(category)} 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, {statusColor(category)} 25%, transparent);"
              title={val}
            >
              <span class="h-[5px] w-[5px] shrink-0 rounded-full" style="background-color: {statusColor(category)}"></span>
              <span class="truncate">{val}</span>
            </span>
          {:else}
            <span class="truncate font-medium" style="color: {statusColor(category)}" title={val}>{val}</span>
          {/if}
          {#if detail}
            <!-- The reason behind the word: Unschedulable, MinimumReplicasUnavailable… -->
            <span class="truncate text-[11px] text-[var(--text-muted)]" title={detail}>{detail}</span>
          {/if}
          </span>
        {/if}
      {:else if column.key === "restarts"}
        {@const restartInfo = podRestarts(resource)}
        {@const restarts = restartInfo.count}
        <span class="inline-flex items-baseline justify-end gap-1.5 overflow-hidden">
          <span
            class={cn("font-mono tabular-nums", restarts > 5 && "font-medium")}
            style:color={restarts > 5
              ? "var(--status-failed)"
              : restarts > 0
                ? "var(--status-pending)"
                : "color-mix(in srgb, var(--text-muted) 55%, var(--bg-primary))"}
          >{restarts}</span>
          {#if restarts > 0 && restartInfo.lastAt}
            <!-- When the last one happened: 7 restarts three days ago is not
                 7 restarts in the last hour. ageTick keeps it live. -->
            {@const _tick = cellCtx.ageTick}
            <span class="shrink-0 font-mono text-[10px] text-[var(--text-muted)]" title="Last restart {restartInfo.lastAt}">↻ {formatAge(restartInfo.lastAt)}</span>
          {/if}
        </span>
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

      {#if ci === lastColumnIndex && onmore && showChrome}
        <RowActions {resource} {resourceType} {onmore} />
      {/if}
    </td>
  {/each}
  {#each trailingMounts as mount (mount.id)}
    <mount.component {resource} />
  {/each}
</tr>
