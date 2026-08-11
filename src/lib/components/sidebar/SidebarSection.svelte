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
     underneath, and doubles as the collapse toggle. -->
<div class="section mt-3.5">
  <div
    class="section-header sticky top-0 z-[1] border-t border-[var(--border-color)]"
    style="background: linear-gradient(var(--sidebar-bg) 82%, transparent); backdrop-filter: blur(2px);"
  >
    <button
      type="button"
      class="flex w-full items-center gap-1 px-[13px] pt-2.5 pb-1.5 text-left transition-colors hover:text-[var(--text-primary)]"
      onclick={() => sidebarStore.toggle(title)}
      aria-expanded={!collapsed}
      aria-controls={contentId}
      disabled={forceOpen}
    >
      <ChevronRight
        class="h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform {collapsed ? '' : 'rotate-90'}"
      />
      <span class="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">{title}</span>
    </button>
  </div>
  {#if !collapsed}
    <div id={contentId} class="flex flex-col">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  /* First section sits directly under the cluster header — no divider border
     and no extra gap, so the list starts flush. */
  .section:first-child {
    margin-top: 0;
  }
  .section:first-child .section-header {
    border-top: none;
  }
</style>
