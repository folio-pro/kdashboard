<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { HTMLButtonAttributes } from "svelte/elements";

  /**
   * A row inside `Menu`. `selected` marks the current value (accent label,
   * `aria-checked`); `tone="danger"` marks destructive entries.
   */
  interface Props extends HTMLButtonAttributes {
    selected?: boolean;
    tone?: "default" | "danger";
    /** Toolbar and log menus label their rows in the mono face. */
    mono?: boolean;
    /**
     * `menuitemradio` (the default) is right for the pickers these menus are
     * used for — container, shell, pod, since, tail — where exactly one row is
     * the current value. Pass `menuitem` for a menu of one-shot actions;
     * `aria-checked` is only emitted for the roles that accept it.
     */
    role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
    class?: string;
  }

  let {
    selected = false,
    tone = "default",
    mono = false,
    role = "menuitemradio",
    class: className,
    children,
    ...restProps
  }: Props = $props();
</script>

<button
  class={cn(
    "block w-full px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--table-row-hover)] disabled:cursor-default disabled:text-[var(--text-muted)] disabled:hover:bg-transparent",
    mono && "font-mono",
    tone === "danger"
      ? "text-[var(--status-failed)]"
      : selected
        ? "text-[var(--accent)]"
        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
    className
  )}
  {role}
  aria-checked={role === "menuitem" ? undefined : selected}
  {...restProps}
>
  {@render children?.()}
</button>
