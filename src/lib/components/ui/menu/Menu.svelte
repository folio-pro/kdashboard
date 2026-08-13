<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  /**
   * The floating surface behind the app's own dropdowns — the log filter bar,
   * the terminal shell/pod pickers, the tab context menu. Eight copies of
   * `absolute top-full … rounded border … bg-[var(--bg-secondary)] py-1
   * shadow-lg` existed, drifting on radius and alignment.
   *
   * This is deliberately not the bits-ui popover: these menus are anchored by
   * a `relative` parent (or positioned `fixed` at a cursor), and swapping them
   * to a portal-based primitive is a behaviour change, not a styling one.
   */
  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** Which edge of the anchor the menu hangs from. */
    align?: "left" | "right";
    /** `fixed` for cursor-anchored context menus, which set their own inset. */
    position?: "absolute" | "fixed";
    /**
     * The menu's own element. `bind:this` on a component yields the component
     * instance, not the node, and callers need the node for outside-click
     * detection and roving focus.
     */
    ref?: HTMLDivElement;
    class?: string;
  }

  let {
    align = "left",
    position = "absolute",
    ref = $bindable(),
    class: className,
    children,
    ...restProps
  }: Props = $props();
</script>

<div
  bind:this={ref}
  class={cn(
    "z-50 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg",
    position === "absolute" && "absolute top-full mt-1",
    position === "absolute" && (align === "right" ? "right-0" : "left-0"),
    position === "fixed" && "fixed",
    className
  )}
  role="menu"
  tabindex="-1"
  {...restProps}
>
  {@render children?.()}
</div>
