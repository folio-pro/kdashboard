<script lang="ts" generics="T extends string | number">
  import { cn } from "$lib/utils";
  import { ChevronDown } from "lucide-svelte";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { buttonVariants } from "../button/index.js";
  import MenuItem from "../menu/MenuItem.svelte";
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
   *
   * The trigger and the rows take their look from `buttonVariants` and
   * `MenuItem` rather than repeating the toolbar control's class string, so a
   * picker cannot drift away from the buttons standing next to it. The trigger
   * cannot be `<Button>` itself: PopoverTrigger renders the element and needs
   * to own it, so it borrows the classes instead.
   */
  let {
    items,
    value,
    label,
    title,
    icon,
    contentClass,
    disabled = false,
  }: {
    items: { value: T; label: string; onSelect: () => void }[];
    value: T;
    /** Trigger text. Defaults to the selected value. */
    label?: string;
    title: string;
    icon?: Snippet;
    contentClass?: string;
    /** Greys out the trigger and keeps the menu shut. */
    disabled?: boolean;
  } = $props();

  let open = $state(false);

  function select(item: { onSelect: () => void }) {
    open = false;
    item.onSelect();
  }
</script>

<Popover bind:open>
  <PopoverTrigger
    class={buttonVariants({ variant: "toolbar", size: "sm", mono: true })}
    {title}
    aria-label={title}
    {disabled}
  >
    {#if icon}{@render icon()}{/if}
    <span class="max-w-[140px] truncate">{label ?? value}</span>
    <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
  </PopoverTrigger>
  <PopoverContent align="start" class={cn("w-fit min-w-[120px] overflow-y-auto p-0 py-1", contentClass)}>
    {#each items as item}
      <MenuItem mono class="whitespace-nowrap" selected={item.value === value} onclick={() => select(item)}>
        {item.label}
      </MenuItem>
    {/each}
  </PopoverContent>
</Popover>
