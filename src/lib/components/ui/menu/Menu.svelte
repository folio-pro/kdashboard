<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  /**
   * The floating surface behind the app's own dropdowns — the log filter bar,
   * the terminal shell/pod pickers, the tab context menu. Eight copies of
   * `absolute top-full … rounded border … bg-[var(--bg-secondary)] py-1
   * shadow-lg` existed, drifting on radius and alignment.
   *
   * This is deliberately not the bits-ui popover, which SelectMenu already
   * wraps for value pickers: what is left here is the cursor-anchored context
   * menu, which has to be positioned at an arbitrary point rather than against
   * a trigger.
   *
   * `role` is NOT defaulted to "menu". That role is a promise of a keyboard
   * model — focus moves into the menu on open, arrow keys rove between items,
   * Escape closes — and this component implements none of it; its one consumer
   * does. Claiming the role from here would hand every future caller an
   * accessibility contract it silently fails to honour, which is worse than no
   * role at all. Pass `role="menu"` — and the `tabindex` and key handling that
   * go with it — only alongside that behaviour.
   */
  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** Which edge of the anchor the menu hangs from. */
    align?: "left" | "right";
    /** `fixed` for cursor-anchored context menus, which set their own inset. */
    position?: "absolute" | "fixed";
    /**
     * Only pass "menu" if you also implement its keyboard model — see above.
     */
    role?: "menu";
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
    role,
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
  {role}
  {...restProps}
>
  {@render children?.()}
</div>
