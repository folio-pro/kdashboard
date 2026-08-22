<script lang="ts">
  import { Badge, SearchField } from "$lib/components/ui";
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { Button } from "$lib/components/ui/button";
  import TopologyCanvas from "./TopologyCanvas.svelte";
  import TopologyLegend from "./TopologyLegend.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { GitFork, AlertTriangle, Maximize2, Minimize2, ShieldCheck } from "lucide-svelte";
  import { topologyStore } from "$lib/stores/topology.svelte";
  import { netpolStore } from "$lib/stores/netpol.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import NetpolPanel from "./NetpolPanel.svelte";
  import { buildOverlay } from "./netpol-layer.logic";

  let searchFilter = $state("");
  let showLegend = $state(true);
  let showPolicies = $state(false);


  function togglePolicies() {
    showPolicies = !showPolicies;
    if (showPolicies && !netpolStore.overview && !netpolStore.isLoading) {
      void netpolStore.loadNetworkPolicies(k8sStore.currentNamespace);
    }
  }

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

  let overlay = $derived(showPolicies && filteredGraph && netpolStore.overview ? buildOverlay(filteredGraph, netpolStore.overview) : null);
  let selectedStatus = $derived(overlay && topologyStore.selectedNodeId ? overlay.status.get(topologyStore.selectedNodeId) ?? null : null);

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

</script>

<ViewPanel
  title={topologyStore.focusedResourceUid ? "Resource Topology" : "Namespace Topology"}
  icon={GitFork}
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
      <Badge appearance="surface" size="sm">
        {topologyStore.graph.total_resources} resources
        {#if topologyStore.graph.clustered}
          · clustered
        {/if}
      </Badge>
      {#if topologyStore.graph.has_cycles}
        <Badge tone="warning" size="sm" class="rounded-md font-normal">
          <AlertTriangle class="h-3 w-3" />
          cycles detected
        </Badge>
      {/if}
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <div class="w-48">
      <SearchField
        size="sm"
        clearable
        placeholder="Filter nodes..."
        ariaLabel="Filter topology nodes"
        bind:value={searchFilter}
      />
    </div>
    <Button variant={showPolicies ? "accent" : "outline"} size="lg" onclick={togglePolicies} title="Overlay NetworkPolicies: isolation per workload and the flows they allow" data-testid="topology-policies">
      <ShieldCheck class="h-3.5 w-3.5" /> Policies
    </Button>
    <Button variant="outline" size="icon-lg" onclick={() => showLegend = !showLegend} title="Toggle legend" aria-label="Toggle legend">
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
      <TopologyCanvas graph={filteredGraph} {overlay} />
      {#if showLegend}
        <div class="absolute bottom-4 left-4">
          <TopologyLegend nodes={filteredGraph.nodes} />
        </div>
      {/if}
      {#if showPolicies}
        <NetpolPanel selected={selectedStatus} namespace={k8sStore.currentNamespace} />
      {/if}
    </div>
  {:else if topologyStore.graph && filteredGraph?.nodes.length === 0}
    <div class="flex h-full items-center justify-center">
      <span class="text-[13px] text-[var(--text-muted)]">No matching resources found</span>
    </div>
  {/if}
</ViewPanel>
