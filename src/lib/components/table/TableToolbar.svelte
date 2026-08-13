<script lang="ts">
  import { RefreshCw, Plus } from "lucide-svelte";
  import { Button, Kbd, SearchField } from "$lib/components/ui";
  import NamespacePicker from "$lib/components/common/NamespacePicker.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  // One bar where there used to be two. The old TitleBar (48px, app-level)
  // carried title + namespace + search; a second toolbar row (38px, inside
  // the table) carried the count + Filter/Refresh/Create. The Filter button
  // only focused the search box that was already on screen, so it is gone.
  interface Props {
    resourceTypeLabel: string;
    count: number;
    isLoading: boolean;
    onrefresh: () => void;
    oncreate: () => void;
  }

  let { resourceTypeLabel, count, isLoading, onrefresh, oncreate }: Props = $props();

  // resourceTypeLabel is already plural ("Pods"), so the old toolbar's
  // `{label}{count === 1 ? "" : "s"}` rendered "5 podss". Depluralise for the
  // singular case instead of appending to an already-plural noun.
  let noun = $derived(
    count === 1
      ? resourceTypeLabel.toLowerCase().replace(/s$/, "")
      : resourceTypeLabel.toLowerCase(),
  );

  let searchInput: HTMLInputElement | undefined = $state();

  function handleSearchKeydown(e: KeyboardEvent) {
    // Down/Up hands control back to the row list without clearing the query.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      uiStore.selectedRowIndex = 0;
      searchInput?.blur();
    }
  }
</script>

<header
  class="flex h-[44px] shrink-0 items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-6"
  data-drag-region
>
  <h1 class="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]" data-drag-region>
    {resourceTypeLabel}
  </h1>

  <NamespacePicker />

  <span class="text-[11px] tabular-nums text-[var(--text-muted)]" aria-live="polite">
    {count}
    {noun}
  </span>

  <div class="flex-1"></div>

  <SearchField
    bind:ref={searchInput}
    id="resource-filter"
    class="w-[260px]"
    placeholder="Search {resourceTypeLabel.toLowerCase()}..."
    ariaLabel="Search {resourceTypeLabel.toLowerCase()}"
    value={uiStore.filter}
    oninput={(e) => uiStore.setFilter((e.target as HTMLInputElement).value)}
    onkeydown={handleSearchKeydown}
  >
    {#snippet trailing()}
      <Kbd>/</Kbd>
    {/snippet}
  </SearchField>

  <Button
    variant="ghost"
    size="icon-sm"
    class="text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
    onclick={onrefresh}
    title="Refresh (r)"
    aria-label="Refresh"
  >
    <RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
  </Button>

  <Button
    variant="accent"
    size="sm"
    class="font-semibold"
    onclick={oncreate}
    title="Create a resource from a YAML manifest on the clipboard"
  >
    <Plus class="h-3.5 w-3.5" />
    Create
  </Button>
</header>
