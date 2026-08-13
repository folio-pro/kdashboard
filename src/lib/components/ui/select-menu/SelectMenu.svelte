<script lang="ts" generics="T extends string | number">
  import { cn } from "$lib/utils";
  import { ChevronDown } from "lucide-svelte";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import type { Snippet } from "svelte";

  /**
   * Compact value picker for panel toolbars: a labelled trigger plus a list of
   * options.
   *
   * Built on the shared Popover (bits-ui) rather than a hand-rolled menu so
   * placement flips automatically when the toolbar sits at the bottom of a
   * panel, the menu escapes any `overflow: hidden` ancestor via the portal, and
   * outside-click / Escape / focus handling come for free. The log and terminal
   * panels each used to carry their own copy of that machinery, driven by a
   * panel-wide `openDropdown` union and manual `stopPropagation()` calls.
   */
  let {
    items,
    value,
    label,
    title,
    icon,
    contentClass,
  }: {
    items: { value: T; label: string; onSelect: () => void }[];
    value: T;
    /** Trigger text. Defaults to the selected value. */
    label?: string;
    title: string;
    icon?: Snippet;
    contentClass?: string;
  } = $props();

  let open = $state(false);

  function select(item: { onSelect: () => void }) {
    open = false;
    item.onSelect();
  }
</script>

<Popover bind:open>
  <PopoverTrigger
    class="flex h-7 shrink-0 items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
    {title}
    aria-label={title}
  >
    {#if icon}{@render icon()}{/if}
    <span class="max-w-[140px] truncate">{label ?? value}</span>
    <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
  </PopoverTrigger>
  <PopoverContent align="start" class={cn("w-fit min-w-[120px] overflow-y-auto p-0 py-1", contentClass)}>
    {#each items as item}
      <button
        class={cn(
          "block w-full px-3 py-1.5 text-left font-mono text-[11px] whitespace-nowrap transition-colors hover:bg-[var(--table-row-hover)]",
          item.value === value ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
        )}
        onclick={() => select(item)}
      >
        {item.label}
      </button>
    {/each}
  </PopoverContent>
</Popover>
