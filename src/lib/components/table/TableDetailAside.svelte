<script lang="ts">
  import { cn } from "$lib/utils";
  import { tablePrefs, ASIDE_MIN_WIDTH } from "./table-prefs.svelte";

  /**
   * The detail panel, docked beside a table. It renders the same DetailPanel
   * the detail tab does (in its `aside` variant), lazily — DetailPanel drags
   * the YAML parser (~97 kB) along, so it loads the first time an aside opens,
   * not with the table. Width is fixed rather than a split so the table keeps
   * its column layout; the left edge drags, and the width persists.
   */
  interface Props {
    onopentab: () => void;
    onclose: () => void;
  }

  let { onopentab, onclose }: Props = $props();

  const detailPanel = import("$lib/components/details/DetailPanel.svelte");

  /** Keep at least this much of the table visible while dragging. */
  const TABLE_MIN_WIDTH = 360;

  let el: HTMLElement | undefined = $state();
  let dragging = $state(false);
  let dragCleanup: (() => void) | null = null;

  function handleResizeStart(e: MouseEvent) {
    e.preventDefault();
    const parent = el?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const maxWidth = Math.max(ASIDE_MIN_WIDTH, bounds.width - TABLE_MIN_WIDTH);
    const widthAt = (clientX: number) => Math.min(maxWidth, Math.max(ASIDE_MIN_WIDTH, bounds.right - clientX));

    // Live width goes straight to the element; the store (and storage) only
    // hear the final value on mouseup.
    function onMove(ev: MouseEvent) {
      if (el) el.style.width = `${widthAt(ev.clientX)}px`;
    }
    function cleanup() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragging = false;
      dragCleanup = null;
    }
    function onUp(ev: MouseEvent) {
      const width = widthAt(ev.clientX);
      cleanup();
      tablePrefs.setAsideWidth(width);
    }
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    dragCleanup = cleanup;
  }

  $effect(() => () => dragCleanup?.());
</script>

<aside
  bind:this={el}
  class="relative flex shrink-0 flex-col border-l border-t border-[var(--border-color)] bg-[var(--bg-primary)]"
  style="width: {tablePrefs.asideWidth}px;"
  aria-label="Resource detail"
>
  <!-- Resize handle on the left edge: 6px hit area, a 2px accent line while
       hovered or dragging. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="group/handle absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize"
    onmousedown={handleResizeStart}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize detail panel"
    title="Drag to resize"
  >
    <div
      class={cn(
        "absolute inset-y-0 left-[2px] w-0.5 transition-colors",
        dragging ? "bg-[var(--accent)]" : "bg-transparent group-hover/handle:bg-[var(--accent)]"
      )}
    ></div>
  </div>

  {#await detailPanel then mod}
    <mod.default variant="aside" {onopentab} {onclose} />
  {:catch}
    <p class="p-4 text-[12px] text-[var(--status-failed)]">Failed to load detail view.</p>
  {/await}
</aside>
