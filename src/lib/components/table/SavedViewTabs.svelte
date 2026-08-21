<script lang="ts">
  import { X, BookmarkPlus } from "lucide-svelte";
  import { Button, Input } from "$lib/components/ui";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { cn } from "$lib/utils";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { viewsFor, isViewActive, viewFromState, isEmptyState, type SavedView } from "./saved-views";

  /**
   * Saved views: the questions you ask this table every day, one click each.
   * The active one is whichever matches the current filter state exactly, so
   * "All" lights up whenever nothing is filtered. Built-ins per type, plus the
   * user's own (saved from the current filters, persisted in settings).
   */
  interface Props {
    resourceType: string;
    /** Row count each view would show, by view id. */
    viewCounts: Record<string, number>;
  }

  let { resourceType, viewCounts }: Props = $props();

  let views = $derived(viewsFor(resourceType, settingsStore.savedViews));
  let filterState = $derived({ facets: uiStore.facets, text: uiStore.filter, statFilter: uiStore.statFilter });
  let activeViewId = $derived(views.find((v) => isViewActive(v, filterState))?.id ?? null);

  let saveOpen = $state(false);
  let saveName = $state("");

  function applyView(view: SavedView) {
    uiStore.applyFilterState({ facets: view.facets ?? [], text: view.text ?? "", statFilter: view.statFilter ?? null });
  }

  function saveCurrentView() {
    const name = saveName.trim();
    if (!name || isEmptyState(filterState)) return;
    settingsStore.addSavedView(viewFromState(name, resourceType, filterState));
    saveName = "";
    saveOpen = false;
  }
</script>

<div class="flex shrink-0 items-center gap-0.5" role="tablist" aria-label="Saved views">
  {#each views as view (view.id)}
    {@const active = activeViewId === view.id}
    {@const n = viewCounts[view.id]}
    <span class="group/view relative flex shrink-0 items-center">
      <Button
        variant="segment"
        size="sm"
        {active}
        activeStyle="raised"
        role="tab"
        aria-selected={active}
        class={cn("gap-1.5 px-2.5", active && "font-medium")}
        onclick={() => applyView(view)}
        title={view.builtin ? undefined : "Saved view"}
      >
        {view.name}
        {#if n !== undefined}
          <span
            class="font-mono text-[11px] tabular-nums"
            style:color={view.id === "attention" && n > 0 ? "var(--status-failed)" : "var(--text-muted)"}
          >{n}</span>
        {/if}
      </Button>
      {#if !view.builtin}
        <button
          type="button"
          class="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--status-failed)] group-hover/view:flex"
          aria-label="Delete view {view.name}"
          onclick={(e) => { e.stopPropagation(); settingsStore.removeSavedView(view.id); }}
        >
          <X class="h-2.5 w-2.5" />
        </button>
      {/if}
    </span>
  {/each}

  <Popover bind:open={saveOpen}>
    <PopoverTrigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="muted"
          size="icon-sm"
          title={isEmptyState(filterState) ? "Filter first, then save the view" : "Save current filters as a view"}
          aria-label="Save current filters as a view"
          disabled={isEmptyState(filterState)}
        >
          <BookmarkPlus class="h-3.5 w-3.5" />
        </Button>
      {/snippet}
    </PopoverTrigger>
    <PopoverContent align="start" class="w-[240px] p-2">
      <form class="flex flex-col gap-2" onsubmit={(e) => { e.preventDefault(); saveCurrentView(); }}>
        <span class="text-[11px] text-[var(--text-muted)]">Name this view</span>
        <Input
          type="text"
          size="sm"
          placeholder="e.g. Prod errors"
          value={saveName}
          oninput={(e) => (saveName = (e.target as HTMLInputElement).value)}
          aria-label="View name"
        />
        <div class="flex justify-end gap-1.5">
          <Button variant="toolbar" size="xs" type="button" onclick={() => (saveOpen = false)}>Cancel</Button>
          <Button variant="accent" size="xs" type="submit" disabled={!saveName.trim()}>Save</Button>
        </div>
      </form>
    </PopoverContent>
  </Popover>
</div>
