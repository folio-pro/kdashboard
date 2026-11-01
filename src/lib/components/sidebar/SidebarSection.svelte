<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronRight } from "lucide-svelte";
  import { sidebarStore } from "$lib/stores/sidebar.svelte";

  interface Props {
    title: string;
    /** Overrides the stored collapse state — used while a nav filter is
     *  active, so a section holding a match is never folded over its hit. */
    forceOpen?: boolean;
    children: Snippet;
  }

  let { title, forceOpen = false, children }: Props = $props();

  let collapsed = $derived(!forceOpen && sidebarStore.isCollapsed(title));
  // $derived, not const: `title` is a prop, and a plain const would freeze
  // aria-controls to whatever section rendered first.
  let contentId = $derived(
    `sidebar-section-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
  );
</script>

<!-- The header sticks to the top of the scroll container while its rows pass
     underneath, and doubles as the collapse toggle. It is painted opaque on
     purpose: a translucent fade let the row sliding under it show through as
     a half-clipped item, which read as the header overlapping the list. -->
<div class="section mt-5">
  <div
    class="section-header sticky top-0 z-[1] bg-[var(--sidebar-bg)]"
  >
    <button
      type="button"
      class="flex h-6 w-full items-center gap-1 px-2 text-left transition-colors hover:text-[var(--text-primary)]"
      onclick={() => sidebarStore.toggle(title)}
      aria-expanded={!collapsed}
      aria-controls={contentId}
      disabled={forceOpen}
    >
      <ChevronRight
        class="h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform {collapsed ? '' : 'rotate-90'}"
      />
      <span class="truncate text-[11px] font-medium text-[var(--text-muted)]">{title}</span>
    </button>
  </div>
  {#if !collapsed}
    <div id={contentId} class="flex flex-col gap-0.5">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  /* First section sits directly under the filter, so the list starts flush. */
  .section:first-child {
    margin-top: 0;
  }
</style>
