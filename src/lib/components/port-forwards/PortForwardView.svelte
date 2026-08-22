<script lang="ts">
  import { open } from "$lib/ipc/shell";
  import { cn } from "$lib/utils";
  import { ChevronsUpDown, Unplug, ExternalLink, Square, Bookmark, BookmarkCheck } from "lucide-svelte";
  import { Button, StatTile } from "$lib/components/ui";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { portForwardStore } from "$lib/stores/port-forwards.svelte";
  import { describeTarget } from "$lib/stores/port-forwards.logic";
  import SavedForwardsTable from "./SavedForwardsTable.svelte";
  import type { Column, PortForwardInfo, SortDirection } from "$lib/types";

  let portForwards = $derived(k8sStore.portForwards ?? []);
  let savedForwards = $derived(portForwardStore.saved);

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
    { key: "actions", label: "Actions", sortable: false, width: "220px" },
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
    <StatTile class="flex-1" label="Active" value={portForwards.length} note="port forwards" />
    <StatTile class="flex-1" label={`Saved in ${k8sStore.currentContext || "this context"}`} value={savedForwards.length} note={`${savedForwards.filter((s) => s.auto_start).length} auto-start`} />
  </div>

  {#if savedForwards.length > 0}
    <div class="px-6 pb-4">
      <SavedForwardsTable forwards={savedForwards} onOpen={openInBrowser} />
    </div>
  {/if}

  <!-- Table -->
  <div class="relative flex-1 overflow-hidden px-6 pb-4">
    <div class="h-full overflow-auto rounded-sm border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      {#if portForwards.length === 0}
        <div class="flex h-full flex-col items-center justify-center py-20">
          <Unplug class="h-6 w-6 text-[var(--text-muted)]" />
          <p class="mt-3 text-[12px] text-[var(--text-muted)]">No active port forwards</p>
          <p class="mt-1 text-[11px] text-[var(--text-muted)]">Open a pod and forward a container port to get started{savedForwards.length ? " — or start a saved forward above" : ""}</p>
        </div>
      {:else}
        <table class="w-full" style="table-layout: fixed;">
          <thead class="sticky top-0 z-10 bg-[var(--bg-secondary)]">
            <tr class="border-b border-[var(--border-hover)]">
              {#each columns as col}
                <th
                  class={cn(
                    "relative h-10 overflow-hidden whitespace-nowrap px-4 text-left text-[11px] font-medium text-[var(--text-muted)]",
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
                  <td class="overflow-hidden px-4 text-[12px]">
                    {#if col.key === "status"}
                      <span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--status-running)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--status-running)]">
                        <span class="h-1.5 w-1.5 rounded-full bg-[var(--status-running)]"></span>
                        Active
                      </span>
                    {:else if col.key === "actions"}
                      {@const savedEntry = portForwardStore.savedFor(pf)}
                      <div class="flex items-center gap-1">
                        <Button
                          variant="ghost-tone"
                          tone={savedEntry ? "accent" : "muted"}
                          size="sm"
                          onclick={() => (savedEntry ? portForwardStore.forget(savedEntry.id) : portForwardStore.save(pf))}
                          title={savedEntry ? `Saved as ${describeTarget(savedEntry)} — click to forget` : "Save this forward to restart it later"}
                          data-testid="port-forward-save"
                        >
                          {#if savedEntry}<BookmarkCheck class="h-3 w-3" />{:else}<Bookmark class="h-3 w-3" />{/if}
                          {savedEntry ? "Saved" : "Save"}
                        </Button>
                        <Button
                          variant="ghost-tone"
                          tone="accent"
                          size="sm"
                          onclick={() => openInBrowser(pf.local_port)}
                        >
                          <ExternalLink class="h-3 w-3" />
                          Open
                        </Button>
                        <Button
                          variant="ghost-tone"
                          tone="error"
                          size="sm"
                          onclick={() => stopPortForward(pf.session_id)}
                        >
                          <Square class="h-3 w-3" />
                          Stop
                        </Button>
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
      <div class="pointer-events-none absolute bottom-7 right-9 z-50 rounded-sm bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--bg-primary)] shadow-lg animate-fade-in-out">
        {copyFeedback}
      </div>
    {/if}
  </div>
</div>
