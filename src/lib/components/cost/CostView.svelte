<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { DollarSign, Cpu, MemoryStick, ChevronDown, ChevronRight } from "lucide-svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  let expandedNamespaces = $state<Set<string>>(new Set());

  function handleBack() {
    costStore.reset();
    uiStore.backToPrevious();
  }

  function handleRefresh() {
    costStore.loadCostOverview(k8sStore.currentNamespace);
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

  function formatCpu(cores: number): string {
    if (cores < 0.001) return "<1m";
    if (cores < 1) return `${Math.round(cores * 1000)}m`;
    return `${cores.toFixed(2)}`;
  }

  function formatMemory(gb: number): string {
    if (gb < 0.01) return `${Math.round(gb * 1024)} Mi`;
    return `${gb.toFixed(2)} Gi`;
  }

  let namespaceLabel = $derived(
    k8sStore.currentNamespace === "All Namespaces"
      ? "All Namespaces"
      : k8sStore.currentNamespace || "default"
  );
</script>

<ViewPanel
  title="Cost Visibility"
  icon={DollarSign}
  namespace={namespaceLabel}
  isLoading={costStore.isLoading}
  error={costStore.error}
  hasData={!!costStore.overview}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Loading cost data..."
  errorMessage="Failed to load cost data"
  emptyMessage="No cost data available"
  emptyHelper="Requires metrics-server installed in your cluster"
>
  {#snippet badge()}
    {#if costStore.overview}
      <span class="rounded-md bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
        {costStore.overview.source}
      </span>
    {/if}
  {/snippet}

  <ScrollArea class="h-full">
    <div class="p-4 space-y-4">
      <!-- Cluster Summary Cards -->
      <div class="grid grid-cols-4 gap-3">
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <DollarSign class="h-3.5 w-3.5" />
            Monthly Estimate
          </div>
          <div class="mt-1 text-lg font-semibold text-[var(--text-primary)]">
            {formatCost(costStore.overview!.cluster_cost_monthly)}
          </div>
          <div class="text-[11px] text-[var(--text-muted)]">
            {formatCost(costStore.overview!.cluster_cost_hourly)}/hr
          </div>
        </div>

        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Cpu class="h-3.5 w-3.5" />
            CPU Usage
          </div>
          <div class="mt-1 text-lg font-semibold text-[var(--text-primary)]">
            {formatCpu(costStore.overview!.total_cpu_cores)}
          </div>
          <div class="text-[11px] text-[var(--text-muted)]">
            cores in use
          </div>
        </div>

        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <MemoryStick class="h-3.5 w-3.5" />
            Memory Usage
          </div>
          <div class="mt-1 text-lg font-semibold text-[var(--text-primary)]">
            {formatMemory(costStore.overview!.total_memory_gb)}
          </div>
          <div class="text-[11px] text-[var(--text-muted)]">
            in use
          </div>
        </div>

        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            Namespaces
          </div>
          <div class="mt-1 text-lg font-semibold text-[var(--text-primary)]">
            {costStore.overview!.namespaces.length}
          </div>
          <div class="text-[11px] text-[var(--text-muted)]">
            with active workloads
          </div>
        </div>
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
              <span class="flex-1 text-sm font-medium text-[var(--text-primary)]">{ns.namespace}</span>
              <span class="text-xs text-[var(--text-muted)]">{ns.workload_count} pods</span>
              <span class="text-xs text-[var(--text-secondary)]">{formatCpu(ns.total_cpu_cores)} CPU</span>
              <span class="text-xs text-[var(--text-secondary)]">{formatMemory(ns.total_memory_gb)} Mem</span>
              <span class="min-w-[70px] text-right text-sm font-medium text-[var(--text-primary)]">
                {formatCost(ns.total_cost_monthly)}/mo
              </span>
            </button>

            {#if expandedNamespaces.has(ns.namespace)}
              <div class="border-t border-[var(--border-color)]">
                <table class="w-full text-xs">
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
                        <td class="px-3 py-1.5 text-right">{formatMemory(w.memory_bytes / (1024 * 1024 * 1024))}</td>
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
</ViewPanel>
