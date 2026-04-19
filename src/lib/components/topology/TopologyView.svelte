<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { Button } from "$lib/components/ui/button";
  import SearchInput from "$lib/components/common/SearchInput.svelte";
  import TopologyCanvas from "./TopologyCanvas.svelte";
  import TopologyLegend from "./TopologyLegend.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { GitFork, AlertTriangle, Maximize2, Minimize2 } from "lucide-svelte";
  import { topologyStore } from "$lib/stores/topology.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  let searchFilter = $state("");
  let showLegend = $state(true);

  let filteredGraph = $derived.by(() => {
    const graph = topologyStore.graph;
    if (!graph || !searchFilter) return graph;

    const lower = searchFilter.toLowerCase();
    const matchingIds = new Set(
      graph.nodes
        .filter(n => n.name.toLowerCase().includes(lower) || n.kind.toLowerCase().includes(lower))
        .map(n => n.id)
    );

    for (const edge of graph.edges) {
      if (matchingIds.has(edge.from) || matchingIds.has(edge.to)) {
        matchingIds.add(edge.from);
        matchingIds.add(edge.to);
      }
    }

    return {
      ...graph,
      nodes: graph.nodes.filter(n => matchingIds.has(n.id)),
      edges: graph.edges.filter(e => matchingIds.has(e.from) && matchingIds.has(e.to)),
    };
  });

  function handleBack() {
    topologyStore.reset();
    uiStore.backToPrevious();
  }

  function handleRefresh() {
    const ns = k8sStore.currentNamespace;
    if (topologyStore.focusedResourceUid) {
      topologyStore.loadResourceTopology(topologyStore.focusedResourceUid, ns);
    } else {
      topologyStore.loadNamespaceTopology(ns);
    }
  }

  let namespaceLabel = $derived(
    k8sStore.currentNamespace === "All Namespaces"
      ? "All Namespaces"
      : k8sStore.currentNamespace || "default"
  );
</script>

<ViewPanel
  title={topologyStore.focusedResourceUid ? "Resource Topology" : "Namespace Topology"}
  icon={GitFork}
  namespace={namespaceLabel}
  isLoading={topologyStore.isLoading}
  error={topologyStore.error}
  hasData={!!topologyStore.graph}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Loading topology..."
  errorMessage="Failed to load topology"
  emptyMessage="No resources to display"
>
  {#snippet badge()}
    {#if topologyStore.graph}
      <span class="rounded-md bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
        {topologyStore.graph.total_resources} resources
        {#if topologyStore.graph.clustered}
          · clustered
        {/if}
      </span>
      {#if topologyStore.graph.has_cycles}
        <span class="flex items-center gap-1 rounded-md bg-[var(--status-pending)]/10 px-2 py-0.5 text-[11px] text-[var(--status-pending)]">
          <AlertTriangle class="h-3 w-3" />
          cycles detected
        </span>
      {/if}
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <div class="w-48">
      <SearchInput placeholder="Filter nodes..." value={searchFilter} onchange={(v) => searchFilter = v} />
    </div>
    <Button variant="outline" size="icon" onclick={() => showLegend = !showLegend} title="Toggle legend" aria-label="Toggle legend">
      {#if showLegend}
        <Minimize2 class="h-3.5 w-3.5" />
      {:else}
        <Maximize2 class="h-3.5 w-3.5" />
      {/if}
    </Button>
  {/snippet}

  {#snippet loadingSkeleton()}
    <Skeleton class="h-40 w-40 rounded-full" />
  {/snippet}

  {#if filteredGraph && filteredGraph.nodes.length > 0}
    <div class="relative h-full">
      <TopologyCanvas graph={filteredGraph} />
      {#if showLegend}
        <div class="absolute bottom-4 left-4">
          <TopologyLegend nodes={filteredGraph.nodes} />
        </div>
      {/if}
    </div>
  {:else if topologyStore.graph && filteredGraph?.nodes.length === 0}
    <div class="flex h-full items-center justify-center">
      <span class="text-sm text-[var(--text-muted)]">No matching resources found</span>
    </div>
  {/if}
</ViewPanel>
