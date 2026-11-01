<script lang="ts">
  import { CardSection, SegmentedControl, StatTile } from "$lib/components/ui";
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { DollarSign, ChevronDown, ChevronRight } from "lucide-svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { rightsizingStore } from "$lib/stores/rightsizing.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
    import { formatCpu, formatBytes } from "$lib/stores/metrics.logic";
  import RightsizingPanel from "./RightsizingPanel.svelte";

  let expandedNamespaces = $state<Set<string>>(new Set());
  /** "costs" is the namespace breakdown; "rightsizing" compares requests with usage. */
  let mode = $state<"costs" | "rightsizing">("costs");

  // ViewPanel reads one state object whichever store the mode is showing.
  let panel = $derived(
    mode === "costs"
      ? { isLoading: costStore.isLoading, error: costStore.error, hasData: !!costStore.overview }
      : { isLoading: rightsizingStore.isLoading && !rightsizingStore.overview, error: rightsizingStore.error, hasData: !!rightsizingStore.overview },
  );

  // Reload the mode on screen and drop the other one: setMode() skips the
  // rightsizing fetch when the store already holds data, which would be the
  // previous namespace's recommendations (and Apply would act on them).
  function handleNamespaceChange(ns: string) {
    if (mode === "rightsizing") {
      costStore.reset();
      rightsizingStore.reset();
      rightsizingStore.loadRightsizing(ns);
    } else {
      rightsizingStore.reset();
      costStore.loadCostOverview(ns);
    }
  }

  function handleRefresh() {
    if (mode === "rightsizing") rightsizingStore.loadRightsizing(k8sStore.currentNamespace);
    else costStore.loadCostOverview(k8sStore.currentNamespace);
  }

  // Each mode loads on entry when its store is empty: on first use, and after
  // a namespace change made in the other mode dropped it.
  function setMode(next: "costs" | "rightsizing") {
    mode = next;
    if (next === "rightsizing" && !rightsizingStore.overview && !rightsizingStore.isLoading) {
      rightsizingStore.loadRightsizing(k8sStore.currentNamespace);
    } else if (next === "costs" && !costStore.overview && !costStore.isLoading) {
      costStore.loadCostOverview(k8sStore.currentNamespace);
    }
  }


  function toggleNamespace(ns: string) {
    const next = new Set(expandedNamespaces);
    if (next.has(ns)) {
      next.delete(ns);
    } else {
      next.add(ns);
    }
    expandedNamespaces = next;
  }

  function formatCost(value: number): string {
    if (value < 0.01) return "<$0.01";
    return `$${value.toFixed(2)}`;
  }

  const GB = 1024 ** 3;

</script>

<ViewPanel
  title="Cost"
  icon={DollarSign}
  isLoading={panel.isLoading}
  error={panel.error}
  hasData={panel.hasData}
  onRefresh={handleRefresh}
  onNamespaceChange={handleNamespaceChange}
  loadingMessage="Loading cost data…"
  errorMessage="Failed to load cost data"
  emptyMessage="No cost data available"
  emptyHelper="Requires metrics-server installed in your cluster"
>
  {#snippet badge()}
    {#if mode === "costs" && costStore.overview}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{costStore.overview.source}</span>
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <SegmentedControl
      ariaLabel="Cost view mode"
      value={mode}
      onchange={setMode}
      items={[{ value: "costs", label: "Costs" }, { value: "rightsizing", label: "Rightsizing", testid: "cost-mode-rightsizing" }]}
      testid="cost-mode"
    />
  {/snippet}

  {#if mode === "rightsizing"}
    <RightsizingPanel />
  {:else}
  {@const overview = costStore.overview!}
  <ScrollArea class="h-full">
    <div class="flex flex-col gap-3 px-6 py-3">
      <div class="grid grid-cols-4 gap-3">
        <StatTile size="lg" label="Monthly estimate" value={formatCost(overview.cluster_cost_monthly)} note={`${formatCost(overview.cluster_cost_hourly)}/hr`} />
        <StatTile size="lg" label="CPU usage" value={formatCpu(overview.total_cpu_cores)} note="cores in use" />
        <StatTile size="lg" label="Memory usage" value={formatBytes(overview.total_memory_gb * GB)} note="in use" />
        <StatTile size="lg" label="Namespaces" value={overview.namespaces.length} note="with active workloads" />
      </div>

      <CardSection title="By namespace" subtitle={`CPU $${overview.cpu_rate_per_core_hour}/core/hr · memory $${overview.memory_rate_per_gb_hour}/GB/hr`}>
        {#snippet actions()}
          <span class="font-mono text-[11px] text-[var(--text-muted)]">updated {new Date(overview.fetched_at).toLocaleTimeString()}</span>
        {/snippet}
        <table class="w-full table-fixed text-[12px]">
          <colgroup>
            <col class="w-[38px]" /><col class="w-[200px]" /><col />
            <col class="w-[72px]" /><col class="w-[80px]" /><col class="w-[80px]" /><col class="w-[112px]" />
          </colgroup>
          <thead>
            <tr class="h-8 border-b border-[var(--border-color)] text-[11px] text-[var(--text-muted)]">
              <th></th>
              <th class="px-2 text-left font-medium">Namespace</th>
              <th class="px-2 text-left font-medium">Share</th>
              <th class="px-2 text-right font-medium">Pods</th>
              <th class="px-2 text-right font-medium">CPU</th>
              <th class="px-2 text-right font-medium">Memory</th>
              <th class="px-2 pr-4 text-right font-medium">Per month</th>
            </tr>
          </thead>
          <tbody>
            {#each overview.namespaces as ns, i (ns.namespace)}
              {@const expanded = expandedNamespaces.has(ns.namespace)}
              {@const share = overview.cluster_cost_monthly > 0 ? Math.round((ns.total_cost_monthly / overview.cluster_cost_monthly) * 100) : 0}
              <tr class="h-9 cursor-pointer border-b border-[var(--border-color)] last:border-b-0 hover:bg-[var(--table-row-hover)]" onclick={() => toggleNamespace(ns.namespace)}>
                <td class="pl-4">
                  {#if expanded}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{:else}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
                </td>
                <td class="truncate px-2">
                  <button type="button" class="w-full truncate text-left text-[var(--text-primary)]" aria-expanded={expanded} onclick={(e) => { e.stopPropagation(); toggleNamespace(ns.namespace); }}>{ns.namespace}</button>
                </td>
                <td class="px-2">
                  <span class="flex items-center gap-2">
                    <span class="h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                      <span class="block h-1 rounded-full" style:width="{share}%" style:background-color={i === 0 ? "var(--text-primary)" : "color-mix(in srgb, var(--text-primary) 38%, var(--bg-secondary))"}></span>
                    </span>
                    <span class="w-8 text-right font-mono text-[var(--text-muted)]">{share}%</span>
                  </span>
                </td>
                <td class="px-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">{ns.workload_count}</td>
                <td class="px-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">{formatCpu(ns.total_cpu_cores)}</td>
                <td class="px-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">{formatBytes(ns.total_memory_gb * GB)}</td>
                <td class="px-2 pr-4 text-right font-mono tabular-nums text-[var(--text-primary)]">{formatCost(ns.total_cost_monthly)}</td>
              </tr>
              {#if expanded}
                {#each ns.workloads as w (w.kind + w.name)}
                  <tr class="h-9 border-b border-[var(--border-color)] bg-[var(--bg-primary)]">
                    <td></td>
                    <td class="truncate px-2 font-mono text-[var(--text-secondary)]" title={w.name}>{w.name}</td>
                    <td class="px-2 font-mono text-[var(--text-muted)]">{formatCost(w.total_cost_hourly)}/hr</td>
                    <td></td>
                    <td class="px-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">{formatCpu(w.cpu_cores)}</td>
                    <td class="px-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">{formatBytes(w.memory_bytes)}</td>
                    <td class="px-2 pr-4 text-right font-mono tabular-nums text-[var(--text-secondary)]">{formatCost(w.total_cost_monthly)}</td>
                  </tr>
                {/each}
              {/if}
            {/each}
          </tbody>
        </table>
      </CardSection>
    </div>
  </ScrollArea>
  {/if}
</ViewPanel>
