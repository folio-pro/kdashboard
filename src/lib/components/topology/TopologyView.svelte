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
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { cn } from "$lib/utils";
  import { buildOverlay, describePeer, unusedPolicies } from "./netpol-layer.logic";

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
        <aside class="absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-[320px] flex-col overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[12px] shadow-lg" data-testid="netpol-panel">
          <div class="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2">
            <ShieldCheck class="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <span class="font-semibold">Network policies</span>
            <span class="text-[11px] text-[var(--text-muted)]">· {k8sStore.currentNamespace}</span>
          </div>
          {#if netpolStore.isLoading && !netpolStore.overview}
            <p class="px-3 py-3 text-[var(--text-muted)]">Reading policies…</p>
          {:else if netpolStore.error}
            <p class="px-3 py-3 text-[var(--status-failed)]">{netpolStore.error}</p>
          {:else if netpolStore.overview}
            {@const o = netpolStore.overview}
            {@const unused = unusedPolicies(o)}
            <div class="flex flex-col gap-2 overflow-y-auto p-3">
              <div class="flex flex-wrap gap-1.5">
                <Badge tone={o.default_deny_ingress ? "success" : "warning"}>{o.default_deny_ingress ? "default-deny ingress" : "no default-deny ingress"}</Badge>
                <Badge tone={o.default_deny_egress ? "success" : "muted"}>{o.default_deny_egress ? "default-deny egress" : "egress open by default"}</Badge>
              </div>
              <div class="grid grid-cols-3 gap-1 text-center text-[11px]">
                <div class="rounded-md border border-[var(--border-color)] p-1.5"><div class="font-mono text-[14px] text-[var(--status-running)]">{o.workloads.filter((w) => w.isolated_ingress && w.isolated_egress).length}</div>isolated</div>
                <div class="rounded-md border border-[var(--border-color)] p-1.5"><div class="font-mono text-[14px] text-[var(--status-pending)]">{o.workloads.filter((w) => w.isolated_ingress !== w.isolated_egress).length}</div>partial</div>
                <div class="rounded-md border border-[var(--border-color)] p-1.5"><div class="font-mono text-[14px] text-[var(--status-failed)]">{o.workloads.filter((w) => !w.isolated_ingress && !w.isolated_egress).length}</div>open</div>
              </div>
              {#if selectedStatus}
                <div class="rounded-md border border-[var(--accent)]/40 bg-[var(--bg-primary)]/40 p-2" data-testid="netpol-selected">
                  <div class="font-mono text-[var(--text-primary)]">{selectedStatus.kind}/{selectedStatus.name}</div>
                  <div class="mt-1 text-[11px] text-[var(--text-secondary)]"><span class="text-[var(--text-muted)]">ingress:</span> {selectedStatus.isolated_ingress ? `from ${describePeer(selectedStatus.allowed_from)}${selectedStatus.allowed_from.ports.length ? ` on ${selectedStatus.allowed_from.ports.join(", ")}` : ""}` : "unrestricted"}</div>
                  <div class="text-[11px] text-[var(--text-secondary)]"><span class="text-[var(--text-muted)]">egress:</span> {selectedStatus.isolated_egress ? `to ${describePeer(selectedStatus.allowed_to)}${selectedStatus.allowed_to.ports.length ? ` on ${selectedStatus.allowed_to.ports.join(", ")}` : ""}` : "unrestricted"}</div>
                  {#if selectedStatus.policies.length}<div class="mt-1 text-[11px] text-[var(--text-muted)]">policies: {selectedStatus.policies.join(", ")}</div>{/if}
                </div>
              {:else}
                <p class="text-[11px] text-[var(--text-muted)]">Click a workload to see what may reach it. Dashed arrows are flows the policies allow inside this namespace.</p>
              {/if}
              <div class="text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">Policies · {o.policy_count}</div>
              {#if o.policies.length === 0}
                <p class="text-[11px] text-[var(--text-muted)]">None in this namespace — every pod accepts traffic from anywhere.</p>
              {/if}
              {#each o.policies as pol (pol.name)}
                <button type="button" class={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--table-row-hover)]")} onclick={() => void openRelatedResourceTab("networkpolicies", pol.name, k8sStore.currentNamespace)} data-testid="netpol-policy">
                  <span class="min-w-0 flex-1 truncate font-mono text-[var(--text-primary)]">{pol.name}</span>
                  <span class="font-mono text-[10px] text-[var(--text-muted)]">{pol.policy_types.map((t) => t[0]).join("")}</span>
                  {#if unused.includes(pol.name)}<Badge tone="warning">selects nothing</Badge>{:else}<span class="font-mono text-[10px] text-[var(--text-muted)]">{pol.pod_count} pods</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </aside>
      {/if}
    </div>
  {:else if topologyStore.graph && filteredGraph?.nodes.length === 0}
    <div class="flex h-full items-center justify-center">
      <span class="text-[13px] text-[var(--text-muted)]">No matching resources found</span>
    </div>
  {/if}
</ViewPanel>
