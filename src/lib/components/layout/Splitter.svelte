<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    direction?: "horizontal" | "vertical";
    onresize: (delta: number) => void;
  }

  let { direction = "horizontal", onresize }: Props = $props();

  let isDragging = $state(false);
  let startPos = $state(0);

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();
    isDragging = true;
    startPos = direction === "horizontal" ? e.clientX : e.clientY;

    function handleMouseMove(e: MouseEvent) {
      if (!isDragging) return;
      const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = startPos - currentPos;
      startPos = currentPos;
      onresize(delta);
    }

    function handleMouseUp() {
      isDragging = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div
  class={cn(
    "group flex shrink-0 items-center justify-center transition-colors",
    direction === "horizontal"
      ? "w-[3px] cursor-col-resize flex-col"
      : "h-[3px] cursor-row-resize flex-row",
    isDragging
      ? "bg-[var(--accent)]"
      : "bg-[var(--border-color)] hover:bg-[var(--border-hover)]"
  )}
  onmousedown={handleMouseDown}
  role="separator"
>
  <div
    class={cn(
      "rounded-full bg-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100",
      direction === "horizontal" ? "h-8 w-0.5" : "h-0.5 w-8"
    )}
  ></div>
</div>
