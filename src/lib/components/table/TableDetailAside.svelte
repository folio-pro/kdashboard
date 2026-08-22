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

  /** Keep at least this much of the table visible beside the aside. */
  const TABLE_MIN_WIDTH = 360;
  /** Arrow-key resize step, in px; Shift makes it coarse. */
  const KEY_STEP = 16;
  const KEY_STEP_COARSE = 64;

  let el: HTMLElement | undefined = $state();
  let dragging = $state(false);
  let dragCleanup: (() => void) | null = null;

  // The widest the aside may be right now: whatever the row leaves after the
  // table's minimum. Tracked live (not just while dragging) so a width saved
  // on a wide display cannot push the table — and this handle — off-screen in
  // a narrower window; the rendered width is clamped to it below.
  let maxWidth = $state(Number.POSITIVE_INFINITY);
  $effect(() => {
    const parent = el?.parentElement;
    if (!parent) return;
    const measure = () => {
      maxWidth = Math.max(ASIDE_MIN_WIDTH, parent.getBoundingClientRect().width - TABLE_MIN_WIDTH);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  });

  let width = $derived(Math.min(tablePrefs.asideWidth, maxWidth));
  const clamp = (w: number) => Math.min(maxWidth, Math.max(ASIDE_MIN_WIDTH, w));

  function handleResizeStart(e: MouseEvent) {
    e.preventDefault();
    // A mouseup that never reached the document (released outside the window)
    // leaves the previous pair of listeners attached; drop them first.
    dragCleanup?.();
    const parent = el?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const widthAt = (clientX: number) => clamp(bounds.right - clientX);

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

  /** The handle sits on the aside's left edge, so Left widens and Right narrows. */
  function handleResizeKeydown(e: KeyboardEvent) {
    const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    let next: number;
    switch (e.key) {
      case "ArrowLeft": next = width + step; break;
      case "ArrowRight": next = width - step; break;
      case "Home": next = ASIDE_MIN_WIDTH; break;
      case "End": if (!Number.isFinite(maxWidth)) return; next = maxWidth; break;
      default: return;
    }
    e.preventDefault();
    tablePrefs.setAsideWidth(clamp(next));
  }
</script>

<aside
  bind:this={el}
  class="relative flex shrink-0 flex-col border-l border-t border-[var(--border-color)] bg-[var(--bg-primary)]"
  style="width: {width}px;"
  aria-label="Resource detail"
>
  <!-- Resize handle on the left edge: 6px hit area, a 2px accent line while
       hovered, focused or dragging. Focusable so the width is reachable from
       the keyboard (arrows, Home/End), with the separator's value contract.
       A focusable separator is the WAI-ARIA window-splitter pattern; the
       a11y lint only knows the static kind. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="group/handle absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize focus:outline-none"
    onmousedown={handleResizeStart}
    onkeydown={handleResizeKeydown}
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    aria-label="Resize detail panel"
    aria-valuenow={Math.round(width)}
    aria-valuemin={ASIDE_MIN_WIDTH}
    aria-valuemax={Number.isFinite(maxWidth) ? Math.round(maxWidth) : undefined}
    title="Drag or use the arrow keys to resize"
  >
    <div
      class={cn(
        "absolute inset-y-0 left-[2px] w-0.5 transition-colors",
        dragging
          ? "bg-[var(--accent)]"
          : "bg-transparent group-hover/handle:bg-[var(--accent)] group-focus-visible/handle:bg-[var(--accent)]"
      )}
    ></div>
  </div>

  {#await detailPanel then mod}
    <mod.default variant="aside" {onopentab} {onclose} />
  {:catch}
    <p class="p-4 text-[12px] text-[var(--status-failed)]">Failed to load detail view.</p>
  {/await}
</aside>
