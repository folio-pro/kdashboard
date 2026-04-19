<script lang="ts">
  import { cn } from "$lib/utils";
  import { ChevronsUpDown } from "lucide-svelte";
  import type { Column, SortDirection } from "$lib/types";

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

<th
  bind:this={thEl}
  class={cn(
    "relative h-10 overflow-hidden whitespace-nowrap px-4 text-left text-[11px] font-medium text-[var(--text-dimmed)]",
    column.sortable && "cursor-pointer select-none hover:text-[var(--text-secondary)]"
  )}
  style={computedStyle}
>
  {#if column.sortable}
    <button
      class="inline-flex items-center gap-1.5"
      onclick={() => onclick(column.key)}
    >
      <span>{column.label}</span>
      <ChevronsUpDown class={cn(
        "h-3.5 w-3.5",
        isActive ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
      )} />
    </button>
  {:else}
    <span>{column.label}</span>
  {/if}
  <!-- Resize handle -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 hover:opacity-100 hover:bg-[var(--accent)] active:bg-[var(--accent)] transition-opacity"
    onmousedown={handleResizeStart}
  ></div>
</th>
