<script lang="ts">
  import { cn } from "$lib/utils";
  import { ChevronsUpDown, ArrowUp, ArrowDown } from "lucide-svelte";
  import type { Column, SortDirection } from "$lib/types";
  import { isRightAlignedColumn } from "./cell-values";

  interface Props {
    column: Column;
    sortColumn: string;
    sortDirection: SortDirection;
    onclick: (key: string) => void;
    onresize?: (width: number) => void;
    widthPx?: number;
  }

  let { column, sortColumn, sortDirection, onclick, onresize, widthPx }: Props = $props();

  const MIN_COL_WIDTH = 40;

  let isActive = $derived(sortColumn === column.key);
  let alignRight = $derived(isRightAlignedColumn(column.key));

  let thEl: HTMLTableCellElement | undefined = $state();
  let dragCleanup: (() => void) | null = null;

  function handleResizeStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!thEl) return;

    const startX = e.clientX;
    const startWidth = thEl.offsetWidth;
    const calcWidth = (clientX: number) => Math.max(MIN_COL_WIDTH, startWidth + (clientX - startX));

    function onMouseMove(ev: MouseEvent) {
      if (thEl) thEl.style.width = `${calcWidth(ev.clientX)}px`;
    }

    function cleanup() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragCleanup = null;
    }

    function onMouseUp(ev: MouseEvent) {
      const finalWidth = calcWidth(ev.clientX);
      cleanup();
      onresize?.(finalWidth);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    dragCleanup = cleanup;
  }

  $effect(() => {
    return () => dragCleanup?.();
  });

  let computedStyle = $derived.by(() => {
    if (widthPx != null) return `width: ${widthPx}px;`;
    if (column.width) return `width: ${column.width};`;
    return "";
  });
</script>

<!-- 32px, 10px uppercase: the header labels the data, it is not data. The
     active sort column is the one exception — it reads in the primary colour
     so you can tell at a glance what order the list is in. -->
<th
  bind:this={thEl}
  class={cn(
    "relative h-8 overflow-hidden whitespace-nowrap px-3.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]",
    alignRight ? "text-right" : "text-left",
    column.sortable && "cursor-pointer select-none hover:text-[var(--text-secondary)]"
  )}
  style={computedStyle}
  data-testid="table-header"
  aria-sort={isActive ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
>
  {#if column.sortable}
    <button
      class={cn(
        "inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors",
        alignRight && "flex-row-reverse",
        isActive && "text-[var(--text-primary)]"
      )}
      onclick={() => onclick(column.key)}
      data-testid="header-{column.key}"
    >
      <span>{column.label}</span>
      {#if isActive && sortDirection === "asc"}
        <ArrowUp class="h-[11px] w-[11px] text-[var(--accent)]" />
      {:else if isActive}
        <ArrowDown class="h-[11px] w-[11px] text-[var(--accent)]" />
      {:else}
        <ChevronsUpDown class="h-3 w-3 text-[var(--text-muted)] opacity-60" />
      {/if}
    </button>
  {:else}
    <span data-testid="header-{column.key}">{column.label}</span>
  {/if}
  <!-- Resize handle -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 hover:opacity-100 hover:bg-[var(--accent)] active:bg-[var(--accent)] transition-opacity"
    onmousedown={handleResizeStart}
  ></div>
</th>
