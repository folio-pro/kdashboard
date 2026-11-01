<script lang="ts">
  import { Badge, SearchField } from "$lib/components/ui";
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { Button } from "$lib/components/ui/button";
  import TopologyCanvas from "./TopologyCanvas.svelte";
  import TopologyLegend from "./TopologyLegend.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { GitFork, AlertTriangle, ShieldCheck } from "lucide-svelte";
  import { topologyStore } from "$lib/stores/topology.svelte";
  import { netpolStore } from "$lib/stores/netpol.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
    import NetpolPanel from "./NetpolPanel.svelte";
  import { buildOverlay } from "./netpol-layer.logic";

  let searchFilter = $state("");
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

  // A focused resource lives in the namespace being left, so a scope change
  // drops the focus (loadNamespaceTopology clears it). The policy overlay
  // reloads when on; when off it is dropped, since togglePolicies() only
  // fetches into an empty store.
  function handleNamespaceChange(ns: string) {
    topologyStore.loadNamespaceTopology(ns);
    if (showPolicies) void netpolStore.loadNetworkPolicies(ns);
    else netpolStore.reset();
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
  title={topologyStore.focusedResourceUid ? "Resource topology" : "Namespace topology"}
  icon={GitFork}
  isLoading={topologyStore.isLoading}
  error={topologyStore.error}
  hasData={!!topologyStore.graph}
  onRefresh={handleRefresh}
  onNamespaceChange={handleNamespaceChange}
  loadingMessage="Loading topology…"
  errorMessage="Failed to load topology"
  emptyMessage="No resources to display"
>
  {#snippet badge()}
    {#if topologyStore.graph}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">
        {topologyStore.graph.total_resources} resources{topologyStore.graph.clustered ? " · clustered" : ""}
      </span>
      {#if topologyStore.graph.has_cycles}
        <Badge tone="warning" size="sm" class="font-normal">
          <AlertTriangle class="h-3 w-3" />
          cycles detected
        </Badge>
      {/if}
      {#if filteredGraph}<TopologyLegend nodes={filteredGraph.nodes} />{/if}
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <div class="w-48">
      <SearchField
        size="sm"
        clearable
        placeholder="Filter nodes"
        ariaLabel="Filter topology nodes"
        bind:value={searchFilter}
      />
    </div>
    <Button variant={showPolicies ? "accent" : "toolbar"} size="sm" onclick={togglePolicies} title="Overlay NetworkPolicies: isolation per workload and the flows they allow" data-testid="topology-policies">
      <ShieldCheck class="h-3.5 w-3.5" /> Policies
    </Button>
  {/snippet}

  {#snippet loadingSkeleton()}
    <Skeleton class="h-40 w-40 rounded-full" />
  {/snippet}

  {#if filteredGraph && filteredGraph.nodes.length > 0}
    <div class="relative h-full">
      <TopologyCanvas graph={filteredGraph} {overlay} />
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
