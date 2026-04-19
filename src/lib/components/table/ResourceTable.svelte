<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Resource } from "$lib/types";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { openResourceDetail } from "$lib/actions/navigation";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import AppTableHeader from "./TableHeader.svelte";
  import AppTableRow from "./TableRow.svelte";
  import BulkActionBar from "./BulkActionBar.svelte";
  import TableEmptyStates from "./TableEmptyStates.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { RefreshCw, LayoutGrid, Filter, ClipboardPaste } from "lucide-svelte";
  import { extensions } from "$lib/extensions";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { isInputElement } from "$lib/utils/keyboard";
  import { costStore } from "$lib/stores/cost.svelte";
  import { contextMenuStore } from "$lib/stores/context-menu.svelte";
  import WorkloadStats from "$lib/components/common/WorkloadStats.svelte";
  import { computeWorkloadStats, matchesStatFilter, isPodNeedingAttention } from "$lib/utils/workload-stats";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { filterResources, sortResources, formatCopyFeedback, computeAllSelected as _computeAllSelected, computeSomeSelected as _computeSomeSelected, handleSelectAll as _handleSelectAll, MIN_COL_WIDTH as _MIN_COL_WIDTH } from "./resource-table";
  import { columnsByType, defaultColumns, getColumnWidth as _getColumnWidth, setColumnWidth as _setColumnWidth } from "./table-columns";

  const MIN_COL_WIDTH = _MIN_COL_WIDTH;

  let columns = $derived(columnsByType[k8sStore.selectedResourceType] ?? defaultColumns);

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

  // Track resized column widths per resource type: { [resourceType]: { [colKey]: widthPx } }
  let columnWidthOverrides: Record<string, Record<string, number>> = $state({});

  function getColumnWidth(colKey: string): number | undefined {
    return _getColumnWidth(columnWidthOverrides, k8sStore.selectedResourceType, colKey);
  }

  function setColumnWidth(colKey: string, width: number) {
    _setColumnWidth(columnWidthOverrides, k8sStore.selectedResourceType, colKey, width);
  }

  // Step 1: Filter (depends on items, debouncedFilter, statFilter — NOT ageTick)
  let filteredItems = $derived.by(() => {
    let items = k8sStore.resources.items;

    if (uiStore.statFilter) {
      const filterKey = uiStore.statFilter;
      const resourceType = k8sStore.selectedResourceType;
      if (filterKey === "needsAttention") {
        items = items.filter((r) => isPodNeedingAttention(r));
      } else {
        items = items.filter((r) => matchesStatFilter(r, resourceType, filterKey));
      }
    }

    if (uiStore.debouncedFilterLower) {
      items = filterResources(items, uiStore.debouncedFilterLower);
    }

    return items;
  });

  // Step 2: Sort (depends on filteredItems, sortColumn, sortDirection — NOT ageTick)
  let filteredResources = $derived(sortResources(filteredItems, uiStore.sortColumn, uiStore.sortDirection as "asc" | "desc"));

  // Virtual scrolling
  const ROW_HEIGHT: Record<string, number> = { compact: 32, comfortable: 40 };
  let scrollRef: HTMLDivElement | undefined = $state();

  const virtualizer = createVirtualizer<HTMLDivElement, Element>({
    count: 0,
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => ROW_HEIGHT[settingsStore.settings.table_density] ?? 40,
    overscan: 10,
  });

  // Sync virtualizer count and row height before DOM renders.
  // setOptions mutates the virtualizer's internal Svelte store, which would
  // retrigger this effect (reading $virtualizer auto-subscribes). Wrap the
  // write in untrack so the loop breaks.
  $effect.pre(() => {
    const count = filteredResources.length;
    const density = settingsStore.settings.table_density;
    untrack(() => {
      $virtualizer.setOptions({
        count,
        estimateSize: () => ROW_HEIGHT[density] ?? 40,
      });
    });
  });

  let virtualItems = $derived($virtualizer.getVirtualItems());
  let paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  let paddingBottom = $derived(virtualItems.length > 0 ? $virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0);

  function handleSort(key: string) {
    uiStore.setSort(key);
  }

  function handleRowClick(resource: Resource, index: number) {
    uiStore.selectedRowIndex = index;
    openResourceDetail(resource);
  }

  function handleRowDblClick(resource: Resource, index: number) {
    uiStore.selectedRowIndex = index;
    openResourceDetail(resource);
  }

  function handleRowContextMenu(resource: Resource, index: number, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const uid = resource.metadata.uid;
    const isInSelection = uiStore.selectedRows.has(uid);

    if (uiStore.selectedCount > 1 && isInSelection) {
      const selectedUids = new Set(uiStore.selectedRows);
      const selectedResources = k8sStore.resources.items.filter((r) =>
        selectedUids.has(r.metadata.uid),
      );
      contextMenuStore.show(event.clientX, event.clientY, {
        type: "bulk",
        resourceType: k8sStore.selectedResourceType,
        resources: selectedResources,
      });
    } else {
      uiStore.clearSelection();
      uiStore.selectedRowIndex = index;
      k8sStore.selectResource(resource);
      contextMenuStore.show(event.clientX, event.clientY, {
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

  let copyFeedback: string = $state("");
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  function handleCellCopy(value: string) {
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedback = formatCopyFeedback(value);
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback = "";
    }, 1500);
  }

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

  let needsAttentionCount = $derived(
    k8sStore.selectedResourceType === "pods"
      ? k8sStore.resources.items.filter(isPodNeedingAttention).length
      : 0
  );

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
          openResourceDetail(resource);
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
          label: settingsStore.settings.table_density === "comfortable" ? "Compact Mode" : "Comfortable Mode",
          icon: LayoutGrid,
          execute: () => settingsStore.updateDensity(
            settingsStore.settings.table_density === "comfortable" ? "compact" : "comfortable",
          ),
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
          execute: async () => {
            try {
              const yaml = await navigator.clipboard.readText();
              if (!yaml.trim()) {
                toastStore.error("Empty clipboard", "No YAML to apply");
                return;
              }
              await invoke("apply_yaml", { yaml });
              toastStore.success("Applied", "YAML resource applied successfully");
              await k8sStore.refreshResources();
            } catch (err) {
              toastStore.error("Apply failed", String(err));
            }
          },
        },
      ],
    });
  }

  function handleBulkDeleteEvt() {
    if (uiStore.selectedCount > 0) confirmBulkDelete();
  }

  onMount(() => {
    window.addEventListener("keydown", handleTableKeydown);
    window.addEventListener("kdash:bulk-delete", handleBulkDeleteEvt);
    return () => {
      window.removeEventListener("keydown", handleTableKeydown);
      window.removeEventListener("kdash:bulk-delete", handleBulkDeleteEvt);
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    };
  });
</script>

<div class="flex h-full flex-col">
  <!-- Workload Stat Cards -->
  <WorkloadStats
    stats={workloadStats.stats}
    healthSegments={workloadStats.healthSegments}
    isLoading={k8sStore.isLoading}
    hasError={!!k8sStore.error}
    skeletonCount={workloadStats.stats.length || 4}
    needsAttention={needsAttentionCount}
  />

  <!-- Bulk Action Bar -->
  <BulkActionBar
    selectedCount={uiStore.selectedCount}
    ondelete={confirmBulkDelete}
    ondeselect={() => uiStore.clearSelection()}
  />

  <!-- Table -->
  <div class="relative flex-1 overflow-hidden px-6 pb-4">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="virtual-scroll-container h-full overflow-auto rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]" bind:this={scrollRef} oncontextmenu={handleTableContextMenu} role="region" aria-label="{resourceTypeLabel} resources">
    {#if k8sStore.isLoading}
      <TableEmptyStates
        state="loading"
        {columns}
        {resourceTypeLabel}
        onretry={retryFromError}
        onclearStatFilter={() => uiStore.clearStatFilter()}
        onclearTextFilter={() => uiStore.setFilter("")}
      />
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
        hasTextFilter={!!uiStore.filter}
        onretry={retryFromError}
        onclearStatFilter={() => uiStore.clearStatFilter()}
        onclearTextFilter={() => uiStore.setFilter("")}
      />
    {:else}
      <table class="w-full" style="table-layout: fixed;" role="grid" aria-label="{resourceTypeLabel} resources">
        <thead class="sticky top-0 z-10 bg-[var(--bg-secondary)]">
          <tr class="border-b border-[var(--border-hover)]">
            <th class="px-4 py-2 text-center" style="width: 40px;">
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && someSelected}
                onCheckedChange={handleSelectAll}
                aria-label="Select all rows"
              />
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
                ondblclick={() => handleRowDblClick(resource, i)}
                oncontextmenu={(e) => handleRowContextMenu(resource, i, e)}
                density={settingsStore.settings.table_density}
                checkboxChecked={uiStore.selectedRows.has(resource.metadata.uid)}
                oncheck={() => handleCheckboxChange(resource.metadata.uid)}
                ondblclickcopy={handleCellCopy}
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

    <!-- Copy feedback toast -->
    {#if copyFeedback}
      <div
        class="pointer-events-none absolute bottom-7 right-9 z-50 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--bg-primary)] shadow-lg animate-fade-in-out"
      >
        {copyFeedback}
      </div>
    {/if}
  </div>
</div>

<style>
  @keyframes fadeInOut {
    0% { opacity: 0; transform: translateY(4px); }
    15% { opacity: 1; transform: translateY(0); }
    80% { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-4px); }
  }

  :global(.animate-fade-in-out) {
    animation: fadeInOut 1.5s ease-in-out forwards;
  }
</style>
