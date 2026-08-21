<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Resource } from "$lib/types";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { openResourceDetail } from "$lib/actions/navigation";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { invoke } from "$lib/ipc/core";
  import TableToolbar from "./TableToolbar.svelte";
  import ApplyYamlDialog from "./ApplyYamlDialog.svelte";
  import AppTableHeader from "./TableHeader.svelte";
  import AppTableRow from "./TableRow.svelte";
  import BulkActionBar from "./BulkActionBar.svelte";
  import TableEmptyStates from "./TableEmptyStates.svelte";
  import TableStatusBar from "./TableStatusBar.svelte";
  import TableDetailAside from "./TableDetailAside.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { RefreshCw, LayoutGrid, Filter, ClipboardPaste } from "lucide-svelte";
  import { extensions } from "$lib/extensions";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { cn } from "$lib/utils";
  import { isInputElement } from "$lib/utils/keyboard";
  import { costStore } from "$lib/stores/cost.svelte";
  import { metricsStore, POD_METRICS_TTL_MS } from "$lib/stores/metrics.svelte";
  import { contextMenuStore } from "$lib/stores/context-menu.svelte";
  import WorkloadStats from "$lib/components/common/WorkloadStats.svelte";
  import { computeWorkloadStats } from "$lib/utils/workload-stats";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { applyFilterState, countActiveFilters, sortResources, computeAllSelected as _computeAllSelected, computeSomeSelected as _computeSomeSelected, handleSelectAll as _handleSelectAll, MIN_COL_WIDTH as _MIN_COL_WIDTH, type FilterState } from "./resource-table";
  import { columnsByType, defaultColumns, minimumTableWidth, GUTTER_WIDTH, getColumnWidth as _getColumnWidth, setColumnWidth as _setColumnWidth } from "./table-columns";
  import { tablePrefs } from "./table-prefs.svelte";
  import { ROW_HEIGHT, nextDensity, DENSITY_LABEL } from "./table-density";
  import { viewsFor } from "./saved-views";
  import type { CellContext } from "./cell-values";

  const MIN_COL_WIDTH = _MIN_COL_WIDTH;

  /** Every column the type defines — the column picker and facet keys see all of them. */
  let allColumns = $derived(columnsByType[k8sStore.selectedResourceType] ?? defaultColumns);

  // With one namespace selected every row would repeat it, so the column goes
  // away on its own and comes back with "All namespaces". On top of that,
  // whatever the user hid in the column picker.
  let namespaceAutoHidden = $derived(!!k8sStore.currentNamespace && allColumns.some((c) => c.key === "namespace"));
  let columns = $derived(
    allColumns.filter(
      (c) => !(c.key === "namespace" && namespaceAutoHidden) && !tablePrefs.isHidden(k8sStore.selectedResourceType, c.key),
    ),
  );

  let minTableWidth = $derived(minimumTableWidth(columns));
  let density = $derived(settingsStore.settings.table_density);

  // Reset node cost cache when context or namespace changes.
  // prevCtx/prevNs are plain `let` (not $state) so writing to them doesn't
  // retrigger the effect via Svelte 5's reactive tracking.
  let prevCtx = "";
  let prevNs = "";
  $effect(() => {
    const ctx = k8sStore.currentContext;
    const ns = k8sStore.currentNamespace;
    if (prevCtx && (ctx !== prevCtx || ns !== prevNs)) {
      costStore.reset();
      metricsStore.reset();
      uiStore.clearStatFilter();
    }
    prevCtx = ctx;
    prevNs = ns;
  });

  // Load node costs and metrics when viewing nodes
  $effect(() => {
    if (k8sStore.selectedResourceType === "nodes") {
      costStore.loadNodeCosts();
      costStore.loadNodeMetrics();
    }
  });

  // Pod usage: fetch on entry to the pods table, then keep it fresh while the
  // view stays open. metrics-server only rescrapes every ~60s, so a poll at the
  // store's TTL is enough — the store itself throttles redundant calls.
  $effect(() => {
    if (k8sStore.selectedResourceType !== "pods") return;
    const ns = k8sStore.currentNamespace;
    // force: the namespace just changed, so whatever is cached describes the
    // previous one and must not be treated as fresh.
    void metricsStore.loadPodMetrics(ns, true);
    const timer = setInterval(() => {
      // A minimized/hidden window doesn't need fresh metrics — skip the IPC +
      // cluster fetch; the next visible tick (or re-entry) refreshes.
      if (document.hidden) return;
      void metricsStore.loadPodMetrics(ns);
    }, POD_METRICS_TTL_MS);
    return () => clearInterval(timer);
  });

  // Track resized column widths per resource type: { [resourceType]: { [colKey]: widthPx } }
  let columnWidthOverrides: Record<string, Record<string, number>> = $state({});

  function getColumnWidth(colKey: string): number | undefined {
    return _getColumnWidth(columnWidthOverrides, k8sStore.selectedResourceType, colKey);
  }

  function setColumnWidth(colKey: string, width: number) {
    _setColumnWidth(columnWidthOverrides, k8sStore.selectedResourceType, colKey, width);
  }

  // Per-resource cell context for facets on usage columns (`cpu:>80`). Plain
  // columns ignore it. ageTick is deliberately NOT read here: formatAge works
  // from the clock, and reading the tick would re-filter the list every 30s.
  function facetCtxFor(r: Resource): CellContext {
    return {
      ageTick: 0,
      nodeMetrics: costStore.getNodeMetrics(r.metadata.name),
      nodeCost: costStore.getNodeCost(r.metadata.name),
      podUsage: metricsStore.getPodUsage(r.metadata.namespace, r.metadata.name),
    };
  }

  function filter(items: Resource[], state: FilterState): Resource[] {
    return applyFilterState(items, state, k8sStore.selectedResourceType, facetCtxFor);
  }

  // Step 1: Filter (depends on items, debouncedFilter, facets, statFilter — NOT ageTick)
  let filterState = $derived<FilterState>({
    statFilter: uiStore.statFilter,
    facets: uiStore.facets,
    text: uiStore.debouncedFilterLower,
  });
  let filteredItems = $derived(filter(k8sStore.resources.items, filterState));

  // Row count per saved view, for the toolbar's view chips — through the same
  // pipeline, so a view's count and its rows can never disagree.
  let viewCounts = $derived.by((): Record<string, number> => {
    const items = k8sStore.resources.items;
    const out: Record<string, number> = {};
    for (const view of viewsFor(k8sStore.selectedResourceType, settingsStore.savedViews)) {
      out[view.id] = filter(items, {
        statFilter: view.statFilter ?? null,
        facets: view.facets ?? [],
        text: view.text ?? "",
      }).length;
    }
    return out;
  });

  function clearAllFilters() {
    uiStore.applyFilterState({ facets: [], text: "", statFilter: null });
  }

  // Step 2: Sort (depends on filteredItems, sortColumn, sortDirection — NOT ageTick)
  let filteredResources = $derived(sortResources(filteredItems, uiStore.sortColumn, uiStore.sortDirection as "asc" | "desc"));
  // Also skeleton while the view has never completed a list: isLoading is
  // deliberately delayed 200ms, which would flash the empty state on boot.
  let showLoadingSkeleton = $derived(
    k8sStore.isLoading ||
      (!k8sStore.viewLoaded && !k8sStore.error && filteredResources.length === 0),
  );

  // Virtual scrolling — row heights come from table-density.ts, which the row
  // component also reads, so the estimate is exact for every preset.
  let scrollRef: HTMLDivElement | undefined = $state();

  const virtualizer = createVirtualizer<HTMLDivElement, Element>({
    count: 0,
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => ROW_HEIGHT.comfortable,
    overscan: 10,
  });

  // Gate on scrollRef so the virtualizer acquires its scroll element on remount.
  // setOptions notifies the virtualizer store; untrack breaks the self-retrigger.
  $effect(() => {
    if (!scrollRef) return;
    const count = filteredResources.length;
    const rowHeight = ROW_HEIGHT[density];
    untrack(() => {
      $virtualizer.setOptions({ count, estimateSize: () => rowHeight });
    });
  });

  let virtualItems = $derived($virtualizer.getVirtualItems());
  let paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  let paddingBottom = $derived(virtualItems.length > 0 ? $virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0);

  function handleSort(key: string) {
    uiStore.setSort(key);
  }

  // Single click previews the row in the aside; double-click (or ⌘↵, or the
  // aside's own button) opens it in a tab. The aside reads the store's
  // selected resource, which the watch keeps live.
  function handleRowClick(resource: Resource, index: number) {
    uiStore.selectedRowIndex = index;
    k8sStore.selectResource(resource);
    uiStore.previewOpen = true;
  }

  function openInTab(resource: Resource) {
    openResourceDetail(resource);
  }

  function closePreview() {
    uiStore.previewOpen = false;
  }

  let previewResource = $derived(uiStore.previewOpen ? k8sStore.selectedResource : null);

  function handleRowContextMenu(resource: Resource, index: number, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openRowMenu(resource, index, event.clientX, event.clientY);
  }

  /** The row's action menu — from a right-click or the row's "…" button. */
  function openRowMenu(resource: Resource, index: number, x: number, y: number) {
    const uid = resource.metadata.uid;
    const isInSelection = uiStore.selectedRows.has(uid);

    if (uiStore.selectedCount > 1 && isInSelection) {
      const selectedUids = new Set(uiStore.selectedRows);
      const selectedResources = k8sStore.resources.items.filter((r) =>
        selectedUids.has(r.metadata.uid),
      );
      contextMenuStore.show(x, y, {
        type: "bulk",
        resourceType: k8sStore.selectedResourceType,
        resources: selectedResources,
      });
    } else {
      uiStore.clearSelection();
      uiStore.selectedRowIndex = index;
      k8sStore.selectResource(resource);
      contextMenuStore.show(x, y, {
        type: "resource",
        resource,
        resourceType: k8sStore.selectedResourceType,
      });
    }
  }

  let trailingHeaderMounts = $derived(
    extensions.mountsFor("table-header-trailing").filter((m) => !m.visible || m.visible()),
  );

  let allSelected = $derived(_computeAllSelected(filteredResources, uiStore.selectedRows));
  let someSelected = $derived(_computeSomeSelected(filteredResources, uiStore.selectedRows));

  function handleSelectAll() {
    const newSelection = _handleSelectAll(allSelected, filteredResources);
    if (newSelection.size === 0) {
      uiStore.clearSelection();
    } else {
      uiStore.selectAllRows([...newSelection]);
    }
  }

  function handleCheckboxChange(uid: string) {
    uiStore.toggleRowSelection(uid);
  }

  async function confirmBulkDelete() {
    const selectedUids = new Set(uiStore.selectedRows);
    const resources = k8sStore.resources.items.filter((r) => selectedUids.has(r.metadata.uid));

    const results = await Promise.allSettled(
      resources.map((resource) =>
        invoke("delete_resource", {
          kind: resource.kind,
          name: resource.metadata.name,
          namespace: resource.metadata.namespace ?? "",
          uid: resource.metadata.uid,
          resource_version: resource.metadata.resource_version,
        })
      )
    );

    let failCount = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        failCount++;
      }
    }

    if (failCount === 0) {
      toastStore.success("Deleted", `${resources.length} resource${resources.length > 1 ? "s" : ""} deleted`);
    } else {
      toastStore.error("Partial failure", `${failCount} of ${resources.length} deletions failed`);
    }

    uiStore.clearSelection();
    await k8sStore.refreshResources();
  }

  let resourceTypeLabel = $derived(
    k8sStore.selectedResourceType.charAt(0).toUpperCase() +
    k8sStore.selectedResourceType.slice(1)
  );

  let prevSelectedRowIndex = -1;
  $effect(() => {
    const idx = uiStore.selectedRowIndex;
    if (idx >= 0 && idx !== prevSelectedRowIndex) {
      $virtualizer.scrollToIndex(idx, { align: "auto" });
      requestAnimationFrame(() => {
        const row = scrollRef?.querySelector<HTMLElement>('tr[tabindex="0"]');
        if (row && document.activeElement !== row) {
          row.focus({ preventScroll: true });
        }
      });
    }
    prevSelectedRowIndex = idx;
  });

  let workloadStats = $derived(computeWorkloadStats(k8sStore.selectedResourceType, k8sStore.resources.items));

  // Folded into computePodStats' single pass over the items (walking every
  // containerStatus twice per flush was measurable on big namespaces).
  let needsAttentionCount = $derived(workloadStats.needsAttention ?? 0);

  // Auto-clear stat filter on resource type change.
  // prevResourceType is a plain `let` so the effect only tracks selectedResourceType.
  let prevResourceType = "";
  $effect(() => {
    const rt = k8sStore.selectedResourceType;
    if (prevResourceType && rt !== prevResourceType) {
      uiStore.clearStatFilter();
    }
    prevResourceType = rt;
  });

  async function retryFromError() {
    const message = k8sStore.error ?? "";
    if (message.startsWith("Failed to load contexts")) {
      await k8sStore.loadContexts();
      return;
    }
    if (message.startsWith("Failed to load namespaces")) {
      await k8sStore.loadNamespaces();
      return;
    }
    await k8sStore.refreshResources();
  }

  function handleTableKeydown(e: KeyboardEvent) {
    if (uiStore.activeView !== "table") return;
    if (isInputElement(e.target)) return;

    const maxIndex = filteredResources.length - 1;
    if (maxIndex < 0) return;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      if (uiStore.selectedRowIndex < maxIndex) {
        uiStore.selectedRowIndex++;
      } else if (uiStore.selectedRowIndex === -1) {
        uiStore.selectedRowIndex = 0;
      }
      return;
    }

    if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      if (uiStore.selectedRowIndex > 0) {
        uiStore.selectedRowIndex--;
      } else if (uiStore.selectedRowIndex === -1) {
        uiStore.selectedRowIndex = 0;
      }
      return;
    }

    if (e.key === "Enter") {
      if (uiStore.selectedRowIndex >= 0 && uiStore.selectedRowIndex <= maxIndex) {
        e.preventDefault();
        const resource = filteredResources[uiStore.selectedRowIndex];
        if (resource) {
          // Enter previews in the aside; ⌘/Ctrl+Enter opens a tab.
          if (e.metaKey || e.ctrlKey) openInTab(resource);
          else handleRowClick(resource, uiStore.selectedRowIndex);
        }
      }
      return;
    }
  }

  function handleTableContextMenu(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("tr") || target.closest("thead")) return;

    event.preventDefault();
    event.stopPropagation();

    contextMenuStore.show(event.clientX, event.clientY, {
      type: "table",
      tableActions: [
        {
          id: "refresh",
          label: "Refresh",
          icon: RefreshCw,
          execute: () => k8sStore.refreshResources(),
        },
        {
          id: "toggle-density",
          label: `Density: ${DENSITY_LABEL[nextDensity(density)]}`,
          icon: LayoutGrid,
          execute: () => settingsStore.updateDensity(nextDensity(density)),
        },
        {
          id: "focus-filter",
          label: "Filter...",
          icon: Filter,
          execute: () => {
            const filterInput = document.getElementById("resource-filter");
            if (filterInput) filterInput.focus();
          },
        },
        {
          id: "paste-yaml",
          label: "Paste & Apply YAML",
          icon: ClipboardPaste,
          // Same preview path as the Create button — this used to apply the
          // clipboard straight to the cluster with no confirmation either.
          execute: handleCreate,
        },
      ],
    });
  }

  function handleBulkDeleteEvt() {
    if (uiStore.selectedCount > 0) confirmBulkDelete();
  }

  // Applying the clipboard is a write to the live cluster, so it goes through
  // a preview first — see ApplyYamlDialog. Both entry points (the Create
  // button and the context menu's "Paste & Apply YAML") funnel through here.
  let applyYamlOpen = $state(false);
  let pendingYaml = $state("");

  async function handleCreate() {
    let yaml: string;
    try {
      yaml = await navigator.clipboard.readText();
    } catch (err) {
      toastStore.error("Cannot read clipboard", String(err));
      return;
    }
    if (!yaml.trim()) {
      toastStore.error("Empty clipboard", "Copy a YAML manifest first, then Create");
      return;
    }
    pendingYaml = yaml;
    applyYamlOpen = true;
  }

  async function confirmApplyYaml() {
    applyYamlOpen = false;
    try {
      await invoke("apply_yaml", { yaml: pendingYaml });
      toastStore.success("Applied", "Resource created from clipboard YAML");
      await k8sStore.refreshResources();
    } catch (err) {
      toastStore.error("Apply failed", String(err));
    } finally {
      pendingYaml = "";
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleTableKeydown);
    window.addEventListener("kdash:bulk-delete", handleBulkDeleteEvt);
    return () => {
      window.removeEventListener("keydown", handleTableKeydown);
      window.removeEventListener("kdash:bulk-delete", handleBulkDeleteEvt);
    };
  });
</script>

<div class="flex h-full flex-col">
  <!-- View header: title, namespace, count, search and the two write actions -->
  <TableToolbar
    {resourceTypeLabel}
    resourceType={k8sStore.selectedResourceType}
    count={filteredResources.length}
    isLoading={k8sStore.isLoading}
    {allColumns}
    {namespaceAutoHidden}
    {viewCounts}
    onrefresh={() => k8sStore.refreshResources()}
    oncreate={handleCreate}
  />

  <!-- Workload Stat Cards -->
  <WorkloadStats
    stats={workloadStats.stats}
    healthSegments={workloadStats.healthSegments}
    isLoading={k8sStore.isLoading}
    hasError={!!k8sStore.error}
    needsAttention={needsAttentionCount}
  />

  <!-- Bulk Action Bar -->
  <BulkActionBar
    selectedCount={uiStore.selectedCount}
    ondelete={confirmBulkDelete}
    ondeselect={() => uiStore.clearSelection()}
  />

  <!-- Table + detail aside -->
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="virtual-scroll-container min-w-0 flex-1 overflow-auto border-t border-[var(--border-color)] bg-[var(--bg-primary)]" bind:this={scrollRef} oncontextmenu={handleTableContextMenu} role="region" aria-label="{resourceTypeLabel} resources">
    {#if showLoadingSkeleton}
      <TableEmptyStates
        state="loading"
        {columns}
        {resourceTypeLabel}
        onretry={retryFromError}
        onclearStatFilter={() => uiStore.clearStatFilter()}
        onclearTextFilter={() => uiStore.setFilter("")}
      />
    {:else if k8sStore.connectionLost}
      <!-- ConnectionErrorOverlay owns the whole window here. Rendering the
           error again underneath it duplicated both the message and its
           "Retry connection" button. -->
    {:else if k8sStore.error}
      <TableEmptyStates
        state="error"
        {columns}
        {resourceTypeLabel}
        error={k8sStore.error}
        onretry={retryFromError}
        onclearStatFilter={() => uiStore.clearStatFilter()}
        onclearTextFilter={() => uiStore.setFilter("")}
      />
    {:else if filteredResources.length === 0}
      <TableEmptyStates
        state="empty"
        {columns}
        {resourceTypeLabel}
        hasStatFilter={!!uiStore.statFilter}
        hasTextFilter={!!uiStore.filter || uiStore.facets.length > 0}
        onretry={retryFromError}
        onclearStatFilter={() => uiStore.clearStatFilter()}
        onclearTextFilter={() => uiStore.applyFilterState({ facets: [], text: "", statFilter: uiStore.statFilter })}
      />
    {:else}
      <table class="w-full" style="table-layout: fixed; min-width: {minTableWidth}px;" role="grid" aria-label="{resourceTypeLabel} resources">
        <thead class="sticky top-0 z-10 bg-[var(--bg-primary)]">
          <tr class="group border-b border-[var(--border-color)]">
            <!-- Gutter: select-all, visible on header hover or once something is selected. -->
            <th class="h-8 p-0 text-center" style="width: {GUTTER_WIDTH}px;">
              <span
                class={cn(
                  "inline-flex items-center justify-center align-middle transition-opacity",
                  someSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 [&:has(:focus-visible)]:opacity-100"
                )}
              >
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && someSelected}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all rows"
                  data-testid="select-all-checkbox"
                />
              </span>
            </th>
            {#each columns as column}
              {@const overrideW = getColumnWidth(column.key)}
              <AppTableHeader
                {column}
                sortColumn={uiStore.sortColumn}
                sortDirection={uiStore.sortDirection}
                onclick={handleSort}
                onresize={(width) => setColumnWidth(column.key, width)}
                widthPx={overrideW}
              />
            {/each}
            {#each trailingHeaderMounts as mount (mount.id)}
              <mount.component />
            {/each}
          </tr>
        </thead>
        <tbody>
          {#if paddingTop > 0}
            <tr><td colspan={columns.length + 1 + trailingHeaderMounts.length} style="height: {paddingTop}px; padding: 0; border: none;"></td></tr>
          {/if}
          {#each virtualItems as row (filteredResources[row.index]?.metadata.uid ?? row.index)}
            {@const resource = filteredResources[row.index]}
            {@const i = row.index}
            {#if resource}
              <AppTableRow
                {resource}
                {columns}
                selected={k8sStore.selectedResource?.metadata.uid === resource.metadata.uid}
                highlighted={uiStore.selectedRowIndex === i}
                resourceType={k8sStore.selectedResourceType}
                onclick={() => handleRowClick(resource, i)}
                ondblclick={() => openInTab(resource)}
                oncontextmenu={(e) => handleRowContextMenu(resource, i, e)}
                onmore={(x, y) => openRowMenu(resource, i, x, y)}
                {density}
                checkboxChecked={uiStore.selectedRows.has(resource.metadata.uid)}
                selectionActive={someSelected}
                oncheck={() => handleCheckboxChange(resource.metadata.uid)}
              />
            {/if}
          {/each}
          {#if paddingBottom > 0}
            <tr><td colspan={columns.length + 1 + trailingHeaderMounts.length} style="height: {paddingBottom}px; padding: 0; border: none;"></td></tr>
          {/if}
        </tbody>
      </table>
    {/if}
    </div>

    {#if previewResource}
      {@const resource = previewResource}
      <TableDetailAside onopentab={() => openInTab(resource)} onclose={closePreview} />
    {/if}
  </div>

  <TableStatusBar
    shown={filteredResources.length}
    total={k8sStore.resources.items.length}
    watching={k8sStore.watching}
    lastUpdatedAt={k8sStore.lastUpdatedAt}
    namespaceHidden={namespaceAutoHidden}
    activeFilters={countActiveFilters({ facets: uiStore.facets, text: uiStore.filter, statFilter: uiStore.statFilter })}
    onclearFilters={clearAllFilters}
  />
</div>

{#if applyYamlOpen}
  <ApplyYamlDialog
    open={applyYamlOpen}
    yaml={pendingYaml}
    context={k8sStore.currentContext}
    namespace={k8sStore.currentNamespace}
    onapply={confirmApplyYaml}
    oncancel={() => { applyYamlOpen = false; pendingYaml = ""; }}
  />
{/if}
