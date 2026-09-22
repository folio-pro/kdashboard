<script lang="ts">
  import { Badge, Button, Kbd, SearchField } from "$lib/components/ui";
  import { onMount, untrack } from "svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { ClipboardCopy, Copy, FileJson, FileText, PanelRightOpen, RefreshCw, Trash2 } from "lucide-svelte";
  import { k8sStore, parseCrdType } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { contextMenuStore } from "$lib/stores/context-menu.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { invoke } from "$lib/ipc/core";
  import { cn } from "$lib/utils";
  import { formatAge } from "$lib/utils/age";
  import { isInputElement } from "$lib/utils/keyboard";
  import AppTableHeader from "$lib/components/table/TableHeader.svelte";
  import TableEmptyStates from "$lib/components/table/TableEmptyStates.svelte";
  import CrdDetailPanel from "./CrdDetailPanel.svelte";
  import { resolveCrdDetail } from "./crd-detail";
  import {
    crdTableColumns,
    crdCellText,
    crdRowActions,
    filterCrdResources,
    moveRowIndex,
    sortCrdResources,
    type CrdRowAction,
  } from "./crd-table.logic";
  import type { Resource } from "$lib/types/index.js";

  // The open detail lives on the tab (uiStore.crdDetailUid): this component is
  // shared by every CRD tab, so local state would leak between them. The
  // object itself is looked up in the live listing so watch updates reach it.
  let detail = $derived(
    resolveCrdDetail(
      k8sStore.crdResources.items,
      uiStore.crdDetailUid,
      uiStore.crdDetailSnapshot,
      k8sStore.isLoading || !k8sStore.viewLoaded,
    ),
  );

  // The CRD behind this tab, from the listed type rather than `selectedCrd`,
  // which only follows the last sidebar click.
  let crd = $derived.by(() => {
    const ref = parseCrdType(k8sStore.selectedResourceType);
    return (ref && k8sStore.findCrd(ref.group, ref.kind)) || k8sStore.selectedCrd;
  });
  let label = $derived(crd ? crd.plural.charAt(0).toUpperCase() + crd.plural.slice(1) : "Resources");
  let clusterScoped = $derived(crd?.scope === "Cluster");

  let printer = $derived(k8sStore.crdResources.columns);
  // One namespace selected (or none to have): every row would repeat it.
  let columns = $derived(crdTableColumns(printer, { showNamespace: !clusterScoped && !k8sStore.currentNamespace }));

  // Per-tab filter and sort, through the same uiStore getters ResourceTable uses.
  let filtered = $derived(filterCrdResources(k8sStore.crdResources.items, uiStore.debouncedFilterLower, printer));
  let rows = $derived(sortCrdResources(filtered, printer, uiStore.sortColumn, uiStore.sortDirection));

  // Skeleton also while the view has never completed a list: isLoading is
  // delayed 200ms, which would otherwise flash the empty state.
  let showLoadingSkeleton = $derived(
    k8sStore.isLoading || (!k8sStore.viewLoaded && !k8sStore.error && k8sStore.crdResources.items.length === 0),
  );

  // Virtualized rows (same pattern as ResourceTable): CRD listings are
  // arbitrary user data and can hold thousands of items — rendering them all
  // makes the DOM (and every reactive update) scale with the dataset.
  const ROW_HEIGHT = 29;
  const GUTTER = 28;
  let scrollRef: HTMLDivElement | undefined = $state();

  const virtualizer = createVirtualizer<HTMLDivElement, Element>({
    count: 0,
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Gate on scrollRef so the virtualizer acquires its scroll element on remount.
  // setOptions notifies the virtualizer store; untrack breaks the self-retrigger.
  $effect(() => {
    if (!scrollRef) return;
    const count = rows.length;
    untrack(() => {
      $virtualizer.setOptions({ count });
    });
  });

  let virtualItems = $derived($virtualizer.getVirtualItems());
  let paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  let paddingBottom = $derived(
    virtualItems.length > 0
      ? $virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0,
  );
  let colspan = $derived(columns.length + 1);

  // Roving tabindex: exactly one row is in the tab order — the focused one,
  // else the first — so Tab enters the table and the arrows move within it.
  let focusIndex = $derived(uiStore.selectedRowIndex >= 0 ? Math.min(uiStore.selectedRowIndex, rows.length - 1) : 0);

  let prevSelectedRowIndex = -1;
  $effect(() => {
    const idx = uiStore.selectedRowIndex;
    if (idx >= 0 && idx !== prevSelectedRowIndex && scrollRef) {
      $virtualizer.scrollToIndex(idx, { align: "auto" });
      requestAnimationFrame(() => {
        const row = scrollRef?.querySelector<HTMLElement>('tr[data-testid="crd-row"][tabindex="0"]');
        if (row && document.activeElement !== row) row.focus({ preventScroll: true });
      });
    }
    prevSelectedRowIndex = idx;
  });

  function openDetail(resource: Resource) {
    uiStore.openCrdDetail(resource);
  }

  function handleRowClick(resource: Resource, index: number) {
    uiStore.selectedRowIndex = index;
    openDetail(resource);
  }

  function handleRowKeydown(e: KeyboardEvent, resource: Resource, index: number) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    handleRowClick(resource, index);
  }

  // j/k/arrows move, Enter opens — the same keys as ResourceTable's handler,
  // which only runs on "table" views.
  function handleWindowKeydown(e: KeyboardEvent) {
    if (uiStore.activeView !== "crd-table" || uiStore.crdDetailUid) return;
    if (isInputElement(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
      const next = moveRowIndex(uiStore.selectedRowIndex, e.key === "j" || e.key === "ArrowDown" ? 1 : -1, rows.length);
      if (next < 0) return;
      e.preventDefault();
      uiStore.selectedRowIndex = next;
      return;
    }
    if (e.key === "Enter") {
      const resource = rows[uiStore.selectedRowIndex];
      if (!resource) return;
      e.preventDefault();
      openDetail(resource);
    }
  }

  function handleFilterKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" && rows.length > 0) {
      // Hand control back to the rows without clearing the query.
      e.preventDefault();
      uiStore.selectedRowIndex = 0;
      (e.target as HTMLElement).blur();
    } else if (e.key === "Escape" && uiStore.filter) {
      e.preventDefault();
      uiStore.setFilter("");
    }
  }

  const ACTION_ICONS: Record<CrdRowAction["id"], unknown> = {
    open: PanelRightOpen,
    "copy-name": ClipboardCopy,
    "copy-namespace": Copy,
    "copy-yaml": FileText,
    "copy-json": FileJson,
    delete: Trash2,
  };

  async function copyToClipboard(what: string, produce: () => string | Promise<string>) {
    try {
      await navigator.clipboard.writeText(await produce());
      toastStore.success("Copied", `${what} copied to clipboard`);
    } catch (err) {
      toastStore.error("Copy failed", String(err));
    }
  }

  function handleRowContextMenu(e: MouseEvent, resource: Resource, index: number) {
    e.preventDefault();
    e.stopPropagation();
    uiStore.selectedRowIndex = index;
    const actions = crdRowActions(resource, {
      open: openDetail,
      copy: copyToClipboard,
      fetchYaml: (r) =>
        invoke<string>("get_resource_yaml", {
          kind: r.kind,
          apiVersion: r.api_version,
          name: r.metadata.name,
          namespace: r.metadata.namespace ?? "",
        }),
      remove: (r) => dialogStore.openDelete(r),
    });
    contextMenuStore.show(e.clientX, e.clientY, {
      type: "table",
      tableActions: actions.map((a) => ({ ...a, icon: ACTION_ICONS[a.id] })),
    });
  }

  function handleBack() {
    uiStore.closeCrdDetail();
  }

  onMount(() => {
    window.addEventListener("keydown", handleWindowKeydown);
    return () => window.removeEventListener("keydown", handleWindowKeydown);
  });
</script>

{#if detail.resource}
  <CrdDetailPanel
    resource={detail.resource}
    deleted={detail.deleted}
    columns={k8sStore.crdResources.columns}
    onback={handleBack}
  />
{:else}
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-[var(--border-color)] px-4 py-2">
      {#if crd}
        <span class="text-[12px] text-[var(--text-muted)]">{crd.group}</span>
        <span class="text-[12px] text-[var(--text-muted)]">/</span>
        <span class="text-[13px] font-medium text-[var(--text-primary)]">{crd.kind}</span>
        <span class="text-[12px] text-[var(--text-muted)]" data-testid="crd-count">
          ({rows.length === k8sStore.crdResources.items.length ? rows.length : `${rows.length}/${k8sStore.crdResources.items.length}`})
        </span>
        {#if clusterScoped}
          <Badge appearance="surface" tone="muted" class="ml-1">cluster-scoped</Badge>
        {/if}
      {/if}
      <SearchField
        id="resource-filter"
        size="sm"
        class="ml-auto w-[280px] min-w-[160px] shrink"
        placeholder="Filter…"
        ariaLabel="Filter {label.toLowerCase()}"
        bind:value={() => uiStore.filter, (v) => uiStore.setFilter(v)}
        onkeydown={handleFilterKeydown}
      >
        {#snippet trailing()}
          <Kbd>/</Kbd>
        {/snippet}
      </SearchField>
      <Button
        variant="toolbar"
        size="icon-sm"
        aria-label="Refresh"
        title="Refresh"
        disabled={k8sStore.isLoading}
        onclick={() => k8sStore.refreshResources()}
      >
        <RefreshCw class={cn("h-3.5 w-3.5", k8sStore.isLoading && "animate-spin")} />
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto" bind:this={scrollRef}>
      {#if showLoadingSkeleton}
        <TableEmptyStates
          state="loading"
          {columns}
          resourceTypeLabel={label}
          onretry={() => k8sStore.refreshResources()}
          onclearStatFilter={() => {}}
          onclearTextFilter={() => uiStore.setFilter("")}
        />
      {:else if k8sStore.connectionLost}
        <!-- ConnectionErrorOverlay owns the whole window here. -->
      {:else if k8sStore.error}
        <TableEmptyStates
          state="error"
          {columns}
          resourceTypeLabel={label}
          error={k8sStore.error}
          onretry={() => k8sStore.refreshResources()}
          onclearStatFilter={() => {}}
          onclearTextFilter={() => uiStore.setFilter("")}
        />
      {:else if rows.length === 0}
        <TableEmptyStates
          state="empty"
          {columns}
          resourceTypeLabel={label}
          {clusterScoped}
          hasTextFilter={!!uiStore.filter}
          onretry={() => k8sStore.refreshResources()}
          onclearStatFilter={() => {}}
          onclearTextFilter={() => uiStore.setFilter("")}
        />
      {:else}
        <table class="w-full text-[12px]" style="table-layout: fixed;" role="grid" aria-label="{label} resources">
          <thead class="sticky top-0 z-10 bg-[var(--bg-primary)]">
            <tr class="border-b border-[var(--border-color)]">
              <th class="h-8 p-0" style="width: {GUTTER}px;"></th>
              {#each columns as column (column.key)}
                <AppTableHeader
                  {column}
                  sortColumn={uiStore.sortColumn}
                  sortDirection={uiStore.sortDirection}
                  onclick={(key) => uiStore.setSort(key)}
                />
              {/each}
            </tr>
          </thead>
          <tbody>
            {#if paddingTop > 0}
              <tr><td {colspan} style="height: {paddingTop}px; padding: 0; border: none;"></td></tr>
            {/if}
            {#each virtualItems as vi (rows[vi.index]?.metadata.uid ?? vi.index)}
              {@const resource = rows[vi.index]}
              {@const i = vi.index}
              {#if resource}
                {@const highlighted = uiStore.selectedRowIndex === i}
                <tr
                  class={cn(
                    "cursor-pointer border-b border-[var(--hairline)] transition-colors",
                    highlighted ? "bg-[var(--accent)]/[0.07]" : "hover:bg-[var(--table-row-hover)]",
                  )}
                  style="height: {ROW_HEIGHT}px;"
                  tabindex={i === focusIndex ? 0 : -1}
                  aria-selected={highlighted}
                  data-testid="crd-row"
                  onclick={() => handleRowClick(resource, i)}
                  onkeydown={(e) => handleRowKeydown(e, resource, i)}
                  onfocus={() => { if (uiStore.selectedRowIndex !== i) uiStore.selectedRowIndex = i; }}
                  oncontextmenu={(e) => handleRowContextMenu(e, resource, i)}
                >
                  <td class="relative p-0" style="width: {GUTTER}px;">
                    {#if highlighted}
                      <span class="absolute inset-y-0 left-0 w-0.5 bg-[var(--accent)]" aria-hidden="true"></span>
                    {/if}
                  </td>
                  {#each columns as column (column.key)}
                    <td
                      class={cn(
                        "overflow-hidden truncate px-3.5",
                        column.key === "name" ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
                        column.key === "age" && "text-right text-[var(--text-muted)]",
                      )}
                    >
                      {#if column.key === "name"}
                        {resource.metadata.name}
                      {:else if column.key === "namespace"}
                        {resource.metadata.namespace ?? "—"}
                      {:else if column.key === "age"}
                        {resource.metadata.creation_timestamp ? formatAge(resource.metadata.creation_timestamp) : "—"}
                      {:else}
                        {crdCellText(resource, column.key, printer) || "—"}
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/if}
            {/each}
            {#if paddingBottom > 0}
              <tr><td {colspan} style="height: {paddingBottom}px; padding: 0; border: none;"></td></tr>
            {/if}
          </tbody>
        </table>
      {/if}
    </div>
  </div>
{/if}
