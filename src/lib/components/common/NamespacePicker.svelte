<script lang="ts">
  import { cn } from "$lib/utils";
  import { ChevronDown, Check, AlertTriangle, RefreshCw, Boxes } from "lucide-svelte";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { k8sStore } from "$lib/stores/k8s.svelte";

  // Lifted out of the old TitleBar so every namespace-scoped view can switch
  // namespaces, not just the resource list. Cost/Security/Helm/Topology used
  // to render the namespace as dead text next to a picker they didn't own.
  let open = $state(false);
  let filter = $state("");

  let filtered = $derived(
    k8sStore.namespaces.filter((ns) => ns.toLowerCase().includes(filter.toLowerCase())),
  );

  function select(ns: string) {
    k8sStore.switchNamespace(ns);
    open = false;
    filter = "";
  }

  // Refresh the list when the picker opens, but no more than once every 5s.
  let fetchedAt = 0;
  $effect(() => {
    if (open && Date.now() - fetchedAt > 5_000) {
      fetchedAt = Date.now();
      k8sStore.loadNamespaces();
    }
  });
</script>

<Popover bind:open>
  <PopoverTrigger>
    <button
      class="flex items-center gap-1.5 rounded-md border border-[var(--border-hover)] bg-[var(--bg-tertiary)] py-1 pl-2 pr-1.5 transition-colors hover:border-[var(--border-color)] hover:bg-[var(--sidebar-active)]"
      aria-label="Change namespace"
    >
      <Boxes class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <span class="text-[12px] text-[var(--text-secondary)]">
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
        bind:value={filter}
        aria-label="Filter namespaces"
        class="h-7 w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
      />
    </div>
    <div class="flex flex-col overflow-y-auto py-1" style="max-height: 240px;">
      {#if k8sStore.namespacesLoadError}
        <div class="mx-2 mb-1 flex flex-col gap-2 rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 p-2">
          <div class="flex items-center gap-1.5 text-[var(--status-failed)]">
            <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
            <span class="text-[11px]">Failed to load namespaces</span>
          </div>
          <button
            class="inline-flex h-6 items-center justify-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            onclick={() => k8sStore.loadNamespaces()}
            title={k8sStore.namespacesLoadError}
          >
            <RefreshCw class="h-3 w-3" />
            Retry
          </button>
        </div>
      {/if}
      {#each filtered as ns}
        <button
          class={cn(
            "flex h-7 shrink-0 items-center gap-2 px-3 text-[12px] whitespace-nowrap transition-colors hover:bg-[var(--sidebar-hover)]",
            ns === k8sStore.currentNamespace ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
          )}
          onclick={() => select(ns)}
        >
          {#if ns === k8sStore.currentNamespace}
            <Check class="h-3 w-3 shrink-0" />
          {:else}
            <span class="h-3 w-3 shrink-0"></span>
          {/if}
          {ns}
        </button>
      {/each}
      {#if filtered.length === 0 && !k8sStore.namespacesLoadError}
        <span class="px-3 py-2 text-[12px] text-[var(--text-muted)]">No namespaces found</span>
      {/if}
    </div>
  </PopoverContent>
</Popover>
