<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
    class?: string;
  }

  let { orientation = "horizontal", decorative = true, class: className, ...restProps }: Props = $props();
</script>

<div
  role={decorative ? "none" : "separator"}
  aria-orientation={!decorative ? orientation : undefined}
  class={cn(
    "shrink-0 bg-[var(--border-color)]",
    orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
    className
  )}
  {...restProps}
></div>
