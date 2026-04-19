<script lang="ts">
  import { open } from "@tauri-apps/plugin-shell";
  import { cn } from "$lib/utils";
  import { ChevronsUpDown, Unplug, ExternalLink, Square } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import type { Column, PortForwardInfo, SortDirection } from "$lib/types";

  let portForwards = $derived(k8sStore.portForwards ?? []);

  // Sort state
  let sortColumn = $state<string>("pod_name");
  let sortDirection = $state<SortDirection>("asc");

  function toggleSort(key: string) {
    if (sortColumn === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortColumn = key;
      sortDirection = "asc";
    }
  }

  let sortedForwards = $derived.by(() => {
    return [...portForwards].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortColumn) {
        case "pod_name":
          aVal = a.pod_name;
          bVal = b.pod_name;
          break;
        case "namespace":
          aVal = a.namespace;
          bVal = b.namespace;
          break;
        case "container_port":
          return sortDirection === "asc"
            ? a.container_port - b.container_port
            : b.container_port - a.container_port;
        case "local_port":
          return sortDirection === "asc"
            ? a.local_port - b.local_port
            : b.local_port - a.local_port;
        default:
          aVal = a.pod_name;
          bVal = b.pod_name;
      }

      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDirection === "asc" ? cmp : -cmp;
    });
  });

  function stopPortForward(sessionId: string) {
    k8sStore.removePortForward(sessionId);
  }

  function openInBrowser(localPort: number) {
    open(`http://localhost:${localPort}`);
  }

  // Column resize state
  const MIN_COL_WIDTH = 40;
  let columnWidths = $state<Record<string, number>>({});
  let dragCleanup: (() => void) | null = null;
  let destroyed = false;

  const columns: Column[] = [
    { key: "pod_name", label: "Pod Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "container_port", label: "Container Port", sortable: true, width: "130px" },
    { key: "local_port", label: "Local Port", sortable: true, width: "130px" },
    { key: "status", label: "Status", sortable: false, width: "100px" },
    { key: "actions", label: "Actions", sortable: false, width: "160px" },
  ];

  function getColumnStyle(col: Column): string {
    const w = columnWidths[col.key];
    if (w != null) return `width: ${w}px;`;
    if (col.width) return `width: ${col.width};`;
    return "";
  }

  function handleResizeStart(e: MouseEvent, colKey: string) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th") as HTMLElement;
    if (!th) return;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;

    function onMouseMove(ev: MouseEvent) {
      const newWidth = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX));
      th.style.width = `${newWidth}px`;
    }

    function cleanup() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragCleanup = null;
    }

    function onMouseUp(ev: MouseEvent) {
      const finalWidth = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX));
      cleanup();
      columnWidths = { ...columnWidths, [colKey]: finalWidth };
    }

    // If component already destroyed, don't attach listeners
    if (destroyed) return;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    dragCleanup = cleanup;
  }

  function getCellValue(pf: PortForwardInfo, key: string): string {
    switch (key) {
      case "pod_name": return pf.pod_name;
      case "namespace": return pf.namespace;
      case "container_port": return String(pf.container_port);
      case "local_port": return `localhost:${pf.local_port}`;
      default: return "";
    }
  }

  let copyFeedback = $state("");
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function handleCellDblClick(event: MouseEvent, value: string) {
    if (!value || value === "-") return;
    const td = (event.target as HTMLElement).closest("td") as HTMLElement | null;
    navigator.clipboard.writeText(value).then(() => {
      if (td) {
        td.classList.add("cell-copied-flash");
        setTimeout(() => td.classList.remove("cell-copied-flash"), 600);
      }
      if (copyTimer) clearTimeout(copyTimer);
      copyFeedback = `Copied: ${value.length > 40 ? value.slice(0, 40) + "..." : value}`;
      copyTimer = setTimeout(() => { copyFeedback = ""; }, 1500);
    }).catch(() => {});
  }

  // Cleanup on destroy
  $effect(() => {
    return () => {
      destroyed = true;
      dragCleanup?.();
      if (copyTimer) clearTimeout(copyTimer);
    };
  });
</script>

<div class="flex h-full flex-col bg-[var(--bg-primary)]">
  <!-- Metric Cards -->
  <div class="flex items-stretch gap-3 px-6 pt-4 pb-4">
    <div class="flex flex-1 flex-col gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
      <span class="text-[10px] font-normal text-[var(--text-muted)]">Total</span>
      <div class="flex items-end gap-1.5">
        <span class="text-lg font-semibold leading-none tabular-nums text-[var(--text-primary)]">{portForwards.length}</span>
        <span class="pb-0.5 text-[10px] text-[var(--text-muted)]">port forwards</span>
      </div>
      <div class="h-1 w-full overflow-hidden rounded-full bg-[var(--border-color)]">
        <div class="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style="width: 100%;"></div>
      </div>
    </div>
  </div>

  <!-- Table -->
  <div class="relative flex-1 overflow-hidden px-6 pb-4">
    <div class="h-full overflow-auto rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      {#if portForwards.length === 0}
        <div class="flex h-full flex-col items-center justify-center py-20">
          <Unplug class="h-6 w-6 text-[var(--text-muted)]" />
          <p class="mt-3 text-xs text-[var(--text-muted)]">No active port forwards</p>
          <p class="mt-1 text-[11px] text-[var(--text-dimmed)]">Open a pod and forward a container port to get started</p>
        </div>
      {:else}
        <table class="w-full" style="table-layout: fixed;">
          <thead class="sticky top-0 z-10 bg-[var(--bg-secondary)]">
            <tr class="border-b border-[var(--border-hover)]">
              {#each columns as col}
                <th
                  class={cn(
                    "relative h-10 overflow-hidden whitespace-nowrap px-4 text-left text-[11px] font-medium text-[var(--text-dimmed)]",
                    col.sortable && "cursor-pointer select-none hover:text-[var(--text-secondary)]"
                  )}
                  style={getColumnStyle(col)}
                >
                  {#if col.sortable}
                    <button
                      class="inline-flex items-center gap-1.5"
                      onclick={() => toggleSort(col.key)}
                    >
                      <span>{col.label}</span>
                      <ChevronsUpDown class={cn(
                        "h-3.5 w-3.5",
                        sortColumn === col.key ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
                      )} />
                    </button>
                  {:else}
                    <span>{col.label}</span>
                  {/if}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 hover:opacity-100 hover:bg-[var(--accent)] active:bg-[var(--accent)] transition-opacity"
                    onmousedown={(e) => handleResizeStart(e, col.key)}
                  ></div>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each sortedForwards as pf}
              <tr class="h-10 cursor-default border-b border-[var(--border-hover)] transition-colors hover:bg-[var(--table-row-hover)]">
                {#each columns as col}
                  <td class="overflow-hidden px-4 text-xs">
                    {#if col.key === "status"}
                      <span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--status-running)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--status-running)]">
                        <span class="h-1.5 w-1.5 rounded-full bg-[var(--status-running)]"></span>
                        Active
                      </span>
                    {:else if col.key === "actions"}
                      <div class="flex items-center gap-1">
                        <button
                          class="inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
                          onclick={() => openInBrowser(pf.local_port)}
                        >
                          <ExternalLink class="h-3 w-3" />
                          Open
                        </button>
                        <button
                          class="inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs text-[var(--status-failed)] transition-colors hover:bg-[var(--status-failed)]/10"
                          onclick={() => stopPortForward(pf.session_id)}
                        >
                          <Square class="h-3 w-3" />
                          Stop
                        </button>
                      </div>
                    {:else if col.key === "local_port"}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <span
                        class="block truncate font-medium text-[var(--accent)]"
                        title={getCellValue(pf, col.key)}
                        ondblclick={(e) => handleCellDblClick(e, getCellValue(pf, col.key))}
                      >
                        {getCellValue(pf, col.key)}
                      </span>
                    {:else if col.key === "pod_name"}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <span
                        class="block truncate font-medium text-[var(--text-primary)]"
                        title={getCellValue(pf, col.key)}
                        ondblclick={(e) => handleCellDblClick(e, getCellValue(pf, col.key))}
                      >
                        {getCellValue(pf, col.key)}
                      </span>
                    {:else}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <span
                        class="block truncate text-[var(--text-secondary)]"
                        title={getCellValue(pf, col.key)}
                        ondblclick={(e) => handleCellDblClick(e, getCellValue(pf, col.key))}
                      >
                        {getCellValue(pf, col.key)}
                      </span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Copy feedback toast -->
    {#if copyFeedback}
      <div class="pointer-events-none absolute bottom-7 right-9 z-50 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--bg-primary)] shadow-lg animate-fade-in-out">
        {copyFeedback}
      </div>
    {/if}
  </div>
</div>
