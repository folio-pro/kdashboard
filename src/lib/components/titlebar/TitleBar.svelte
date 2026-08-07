<script lang="ts">
  import { cn } from "$lib/utils";
  import { Search, ChevronDown, Check, AlertTriangle, RefreshCw, Boxes } from "lucide-svelte";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  let resourceTypeLabel = $derived(
    k8sStore.selectedResourceType.charAt(0).toUpperCase() +
    k8sStore.selectedResourceType.slice(1)
  );

  let searchInput: HTMLInputElement | undefined = $state();
  let nsOpen = $state(false);
  let nsFilter = $state("");

  let filteredNamespaces = $derived(
    k8sStore.namespaces.filter((ns) =>
      ns.toLowerCase().includes(nsFilter.toLowerCase())
    )
  );

  function handleSearchInput(e: Event) {
    const target = e.target as HTMLInputElement;
    uiStore.setFilter(target.value);
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      uiStore.selectedRowIndex = 0;
      searchInput?.blur();
    }
  }

  function selectNamespace(ns: string) {
    k8sStore.switchNamespace(ns);
    nsOpen = false;
    nsFilter = "";
  }

  async function retryLoadNamespaces() {
    await k8sStore.loadNamespaces();
  }

  let nsFetchedAt = 0;
  $effect(() => {
    if (nsOpen && Date.now() - nsFetchedAt > 5_000) {
      nsFetchedAt = Date.now();
      k8sStore.loadNamespaces();
    }
  });
</script>

<header
  class="flex h-[48px] shrink-0 items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-6"
  data-drag-region
>
  <!-- Left: Page title + Namespace badge -->
  <div class="flex items-center gap-3" data-drag-region>
    <span class="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]" data-drag-region>
      {resourceTypeLabel}
    </span>

    <Popover bind:open={nsOpen}>
      <PopoverTrigger>
        <button
          class="flex items-center gap-1.5 rounded-md border border-[var(--border-hover)] bg-[var(--bg-tertiary)] py-1 pl-2 pr-1.5 transition-colors hover:border-[var(--border-color)] hover:bg-[var(--sidebar-active)]"
        >
          <Boxes class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <span class="text-xs text-[var(--text-secondary)]">
            {k8sStore.currentNamespace || "All Namespaces"}
          </span>
          <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-fit p-0">
        <div class="p-2">
          <input
            type="text"
            placeholder="Filter namespaces..."
            bind:value={nsFilter}
            class="h-7 w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>
        <div
          class="flex flex-col overflow-y-auto py-1"
          style="max-height: 240px;"
        >
          {#if k8sStore.namespacesLoadError}
            <div class="mx-2 mb-1 flex flex-col gap-2 rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 p-2">
              <div class="flex items-center gap-1.5 text-[var(--status-failed)]">
                <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
                <span class="text-[11px]">Failed to load namespaces</span>
              </div>
              <button
                class="inline-flex h-6 items-center justify-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                onclick={retryLoadNamespaces}
                title={k8sStore.namespacesLoadError}
              >
                <RefreshCw class="h-3 w-3" />
                Retry
              </button>
            </div>
          {/if}
          {#each filteredNamespaces as ns}
            <button
              class={cn(
                "flex h-7 shrink-0 items-center gap-2 px-3 text-xs whitespace-nowrap transition-colors hover:bg-[var(--sidebar-hover)]",
                ns === k8sStore.currentNamespace ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
              )}
              onclick={() => selectNamespace(ns)}
            >
              {#if ns === k8sStore.currentNamespace}
                <Check class="h-3 w-3 shrink-0" />
              {:else}
                <span class="h-3 w-3 shrink-0"></span>
              {/if}
              {ns}
            </button>
          {/each}
          {#if filteredNamespaces.length === 0 && !k8sStore.namespacesLoadError}
            <span class="px-3 py-2 text-xs text-[var(--text-muted)]">No namespaces found</span>
          {/if}
        </div>
      </PopoverContent>
    </Popover>
  </div>

  <!-- Right: Search -->
  <div class="flex items-center gap-2">
    <div class="flex h-8 w-[260px] items-center gap-2 rounded-md border border-[var(--border-hover)] bg-[var(--bg-tertiary)] px-2.5 transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]">
      <Search class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <input
        bind:this={searchInput}
        id="resource-filter"
        type="text"
        placeholder="Search resources..."
        value={uiStore.filter}
        oninput={handleSearchInput}
        onkeydown={handleSearchKeydown}
        class="h-full flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
      />
      <kbd class="shrink-0 rounded border border-[var(--border-hover)] px-1 font-mono text-[10px] leading-[14px] text-[var(--text-dimmed)]">/</kbd>
    </div>
  </div>
</header>
