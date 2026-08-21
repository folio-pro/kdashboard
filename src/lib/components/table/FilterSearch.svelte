<script lang="ts">
  import { X } from "lucide-svelte";
  import { Kbd, SearchField } from "$lib/components/ui";
  import { uiStore } from "$lib/stores/ui.svelte";
  import type { Column } from "$lib/types";
  import { extractFacets, facetToText, facetOpLabel, isCommittableFacet } from "./table-filter";

  /**
   * The table's search box. Typed `key:value` terms become chips ahead of the
   * free text: space after a complete term or Enter commits, Backspace on an
   * empty box pulls the last chip back in for editing, Escape clears both.
   * State lives on the tab (uiStore.filter / uiStore.facets).
   */
  interface Props {
    resourceTypeLabel: string;
    /** Every column the type defines — the keys a term may resolve to. */
    allColumns: Column[];
  }

  let { resourceTypeLabel, allColumns }: Props = $props();

  let input: HTMLInputElement | undefined = $state();

  function labelFor(key: string): string {
    return allColumns.find((c) => c.key === key)?.label ?? key;
  }

  /** Push text into both the store and the box — the box owns its value between keystrokes. */
  function setText(text: string) {
    uiStore.setFilter(text);
    if (input) input.value = text;
  }

  /** Lift any `key:value` terms out of the text into chips. */
  function commitFacets(): boolean {
    const { facets, text } = extractFacets(uiStore.filter, allColumns);
    if (facets.length === 0) return false;
    uiStore.addFacets(facets);
    setText(text);
    return true;
  }

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        // Hand control back to the row list without clearing the query.
        e.preventDefault();
        uiStore.selectedRowIndex = 0;
        input?.blur();
        return;
      case "Enter":
        if (commitFacets()) e.preventDefault();
        return;
      case " ": {
        // Space after a complete term commits just that term; mid-word space is a space.
        const value = uiStore.filter;
        const last = value.slice(value.lastIndexOf(" ") + 1);
        if (isCommittableFacet(last, allColumns) && commitFacets()) e.preventDefault();
        return;
      }
      case "Backspace":
        if (uiStore.filter === "" && uiStore.facets.length > 0) {
          e.preventDefault();
          const last = uiStore.popFacet();
          if (last) setText(facetToText(last));
        }
        return;
      case "Escape":
        if (uiStore.filter || uiStore.facets.length > 0) {
          e.preventDefault();
          uiStore.applyFilterState({ facets: [], text: "", statFilter: uiStore.statFilter });
          if (input) input.value = "";
        }
        return;
    }
  }
</script>

<!-- The one flexible item in the toolbar: on a narrow window it gives way
     first, down to a still-usable minimum, so the controls never clip. -->
<SearchField
  bind:ref={input}
  id="resource-filter"
  class="ml-auto w-[340px] min-w-[160px] shrink"
  placeholder={uiStore.facets.length ? "…" : "Search or key:value…"}
  ariaLabel="Search {resourceTypeLabel.toLowerCase()}"
  value={uiStore.filter}
  oninput={(e) => uiStore.setFilter((e.target as HTMLInputElement).value)}
  onkeydown={handleKeydown}
>
  {#snippet leading()}
    {#each uiStore.facets as facet, i (facetToText(facet))}
      <span
        class="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-[var(--text-primary)]"
        style="background-color: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent);"
        title={facetToText(facet)}
      >
        <span class="text-[var(--text-muted)]">{labelFor(facet.key).toLowerCase()}:</span>
        <span class="font-mono font-medium">{facetOpLabel(facet.op)}{facet.value}</span>
        <button
          type="button"
          class="-mr-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          aria-label="Remove filter {facetToText(facet)}"
          onclick={() => uiStore.removeFacet(i)}
        >
          <X class="h-2.5 w-2.5" />
        </button>
      </span>
    {/each}
  {/snippet}
  {#snippet trailing()}
    <Kbd>/</Kbd>
  {/snippet}
</SearchField>
