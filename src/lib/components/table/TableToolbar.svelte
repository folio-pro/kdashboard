<script lang="ts">
  import { Search, RefreshCw, Plus } from "lucide-svelte";
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

  <div
    class="focus-ring-host flex h-8 w-[260px] items-center gap-2 rounded-md border border-[var(--border-hover)] bg-[var(--bg-tertiary)] px-2.5 transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]"
  >
    <Search class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
    <input
      bind:this={searchInput}
      id="resource-filter"
      type="text"
      placeholder="Search {resourceTypeLabel.toLowerCase()}..."
      aria-label="Search {resourceTypeLabel.toLowerCase()}"
      value={uiStore.filter}
      oninput={(e) => uiStore.setFilter((e.target as HTMLInputElement).value)}
      onkeydown={handleSearchKeydown}
      class="h-full flex-1 bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
    />
    <kbd class="shrink-0 rounded border border-[var(--border-hover)] px-1 font-mono text-[10px] leading-[14px] text-[var(--text-muted)]">/</kbd>
  </div>

  <button
    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
    onclick={onrefresh}
    title="Refresh (r)"
    aria-label="Refresh"
  >
    <RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
  </button>

  <button
    class="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-[12px] font-semibold text-[var(--bg-primary)] transition-colors hover:bg-[var(--accent-hover)]"
    onclick={oncreate}
    title="Create a resource from a YAML manifest on the clipboard"
  >
    <Plus class="h-3.5 w-3.5" />
    Create
  </button>
</header>
