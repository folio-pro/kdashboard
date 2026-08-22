<script lang="ts">
  import { Badge, SegmentedControl, StatTile } from "$lib/components/ui";
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { DollarSign, Cpu, MemoryStick, ChevronDown, ChevronRight } from "lucide-svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { rightsizingStore } from "$lib/stores/rightsizing.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
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

  function handleBack() {
    costStore.reset();
    rightsizingStore.reset();
    uiStore.backToPrevious();
  }

  function handleRefresh() {
    if (mode === "rightsizing") rightsizingStore.loadRightsizing(k8sStore.currentNamespace);
    else costStore.loadCostOverview(k8sStore.currentNamespace);
  }

  function setMode(next: "costs" | "rightsizing") {
    mode = next;
    if (next === "rightsizing" && !rightsizingStore.overview && !rightsizingStore.isLoading) {
      rightsizingStore.loadRightsizing(k8sStore.currentNamespace);
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
  title="Cost Visibility"
  icon={DollarSign}
  isLoading={panel.isLoading}
  error={panel.error}
  hasData={panel.hasData}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Loading cost data..."
  errorMessage="Failed to load cost data"
  emptyMessage="No cost data available"
  emptyHelper="Requires metrics-server installed in your cluster"
>
  {#snippet badge()}
    {#if mode === "costs" && costStore.overview}
      <Badge appearance="surface" size="sm">
        {costStore.overview.source}
      </Badge>
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
  <ScrollArea class="h-full">
    <div class="p-4 space-y-4">
      <!-- Cluster Summary Cards -->
      <div class="grid grid-cols-4 gap-3">
        <StatTile label="Monthly Estimate" icon={DollarSign} value={formatCost(costStore.overview!.cluster_cost_monthly)} note={`${formatCost(costStore.overview!.cluster_cost_hourly)}/hr`} mono={false} />
        <StatTile label="CPU Usage" icon={Cpu} value={formatCpu(costStore.overview!.total_cpu_cores)} note="cores in use" mono={false} />
        <StatTile label="Memory Usage" icon={MemoryStick} value={formatBytes(costStore.overview!.total_memory_gb * GB)} note="in use" mono={false} />
        <StatTile label="Namespaces" value={costStore.overview!.namespaces.length} note="with active workloads" mono={false} />
      </div>

      <!-- Pricing Info -->
      <div class="flex items-center gap-4 rounded-md bg-[var(--bg-tertiary)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
        <span>Rates: CPU ${costStore.overview!.cpu_rate_per_core_hour}/core/hr &middot; Memory ${costStore.overview!.memory_rate_per_gb_hour}/GB/hr</span>
        <span>&middot; Updated {new Date(costStore.overview!.fetched_at).toLocaleTimeString()}</span>
      </div>

      <!-- Namespace Breakdown -->
      <div class="space-y-1">
        {#each costStore.overview!.namespaces as ns}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <button
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
              onclick={() => toggleNamespace(ns.namespace)}
            >
              {#if expandedNamespaces.has(ns.namespace)}
                <ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />
              {:else}
                <ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
              {/if}
              <span class="flex-1 text-[13px] font-medium text-[var(--text-primary)]">{ns.namespace}</span>
              <span class="text-[12px] text-[var(--text-muted)]">{ns.workload_count} pods</span>
              <span class="text-[12px] text-[var(--text-secondary)]">{formatCpu(ns.total_cpu_cores)} CPU</span>
              <span class="text-[12px] text-[var(--text-secondary)]">{formatBytes(ns.total_memory_gb * GB)} Mem</span>
              <span class="min-w-[70px] text-right text-[13px] font-medium text-[var(--text-primary)]">
                {formatCost(ns.total_cost_monthly)}/mo
              </span>
            </button>

            {#if expandedNamespaces.has(ns.namespace)}
              <div class="border-t border-[var(--border-color)]">
                <table class="w-full text-[12px]">
                  <thead>
                    <tr class="text-[var(--text-muted)]">
                      <th class="px-3 py-1.5 text-left font-medium">Pod</th>
                      <th class="px-3 py-1.5 text-right font-medium">CPU</th>
                      <th class="px-3 py-1.5 text-right font-medium">Memory</th>
                      <th class="px-3 py-1.5 text-right font-medium">$/hr</th>
                      <th class="px-3 py-1.5 text-right font-medium">$/mo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each ns.workloads as w}
                      <tr class="border-t border-[var(--border-color)]/50 text-[var(--text-secondary)]">
                        <td class="px-3 py-1.5 font-mono text-[var(--text-primary)]">{w.name}</td>
                        <td class="px-3 py-1.5 text-right">{formatCpu(w.cpu_cores)}</td>
                        <td class="px-3 py-1.5 text-right">{formatBytes(w.memory_bytes)}</td>
                        <td class="px-3 py-1.5 text-right">{formatCost(w.total_cost_hourly)}</td>
                        <td class="px-3 py-1.5 text-right font-medium">{formatCost(w.total_cost_monthly)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </ScrollArea>
  {/if}
</ViewPanel>
