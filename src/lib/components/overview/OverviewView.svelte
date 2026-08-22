<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Badge, Button, CardSection, SegmentedControl, StatTile, toneStyle } from "$lib/components/ui";
  import { LayoutDashboard, AlertTriangle, ArrowRight, Server, Activity, Flame } from "lucide-svelte";
  import { overviewStore } from "$lib/stores/overview.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { openAppView, openRelatedResourceTab } from "$lib/actions/navigation";
  import { formatCpu, formatBytes } from "$lib/stores/metrics.logic";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { formatAge } from "$lib/utils/age";
  import { cn } from "$lib/utils";
  import type { NodeSummary, Problem } from "$lib/types";
  import { nodePressure, nodeNeedsAttention, overviewTiles } from "./overview.logic";

  let overview = $derived(overviewStore.overview);
  let tiles = $derived(overview ? overviewTiles(overview) : []);
  let topProblems = $derived(overview ? overview.problems.slice(0, 6) : []);
  let topMode = $state<"cpu" | "memory">("cpu");
  let topPods = $derived(overview ? (topMode === "cpu" ? overview.top_pods_cpu : overview.top_pods_memory) : []);
  let topMax = $derived(topPods.reduce((m, p) => Math.max(m, topMode === "cpu" ? p.cpu_usage : p.memory_usage), 0));

  function handleBack() {
    overviewStore.reset();
    uiStore.backToPrevious();
  }
  function handleRefresh() {
    overviewStore.loadOverview(k8sStore.currentNamespace);
  }
  function openProblem(p: Problem) {
    void openRelatedResourceTab(kindToResourceType(p.kind), p.name, p.namespace ?? undefined);
  }
  function openNode(n: NodeSummary) {
    void openRelatedResourceTab("nodes", n.name);
  }
  function barColor(percent: number | null): string {
    if (percent === null) return "var(--text-muted)";
    if (percent > 90) return "var(--status-failed)";
    if (percent > 75) return "var(--status-pending)";
    return "var(--accent)";
  }
</script>

{#snippet meter(label: string, percent: number | null)}
  <span class="flex flex-col gap-1">
    <span class="flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
      <span>{label}</span>
      <span>{percent === null ? "" : `${percent} %`}</span>
    </span>
    <span class="h-1 rounded-full bg-[var(--bg-tertiary)]"><span class="block h-1 rounded-full" style="width: {percent ?? 0}%; background: {barColor(percent)}"></span></span>
  </span>
{/snippet}

<ViewPanel
  title="Overview"
  icon={LayoutDashboard}
  isLoading={overviewStore.isLoading}
  error={overviewStore.error}
  hasData={!!overview}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Reading the cluster…"
  errorMessage="Could not build the overview"
>
  {#snippet badge()}
    {#if overview}
      <Badge tone={overview.scope === "cluster" ? "success" : "warning"}>
        {overview.scope === "cluster" ? "whole cluster" : `namespace ${overview.namespace}`}
      </Badge>
      {#if overview.partial.length > 0}
        <Badge tone="warning" title={`Could not list: ${overview.partial.join(", ")}`}>partial</Badge>
      {/if}
    {/if}
  {/snippet}

  {#if overview}
    <ScrollArea class="h-full">
      <div class="flex flex-col gap-4 p-4" data-testid="overview">
        <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {#each tiles as tile (tile.label)}
            <StatTile label={tile.label} value={tile.value} note={tile.note} tone={tile.tone === "neutral" ? "neutral" : tile.tone} size="lg" dot data-testid="overview-tile" />
          {/each}
        </div>

        <div class="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          <CardSection title="Nodes" icon={Server} subtitle={`requests over allocatable${overview.metrics_available ? " · usage from metrics-server" : ""}`} data-testid="overview-nodes">
            {#if overview.nodes.length === 0}
              <p class="px-3 py-4 text-[12px] text-[var(--text-muted)]">Nodes are not listable with these credentials.</p>
            {:else}
              <div class="flex flex-col py-1">
                {#each overview.nodes as n (n.name)}
                  {@const p = nodePressure(n)}
                  <button
                    type="button"
                    class="grid grid-cols-[minmax(140px,1.2fr)_1fr_1fr_auto] items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--table-row-hover)]"
                    onclick={() => openNode(n)}
                    title={[n.instance_type, n.zone, n.kubelet_version].filter(Boolean).join(" · ")}
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <span class={cn("h-1.5 w-1.5 shrink-0 rounded-full", !n.ready ? "bg-[var(--status-failed)]" : nodeNeedsAttention(n) ? "bg-[var(--status-pending)]" : "bg-[var(--status-running)]")}></span>
                      <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{n.name}</span>
                      {#if !n.ready}<Badge tone="error">NotReady</Badge>{/if}
                      {#each n.pressure as pr}<Badge tone="warning">{pr}</Badge>{/each}
                      {#if n.unschedulable}<Badge tone="muted">cordoned</Badge>{/if}
                    </span>
                    {@render meter(`${n.cpu_requests === null ? "—" : formatCpu(n.cpu_requests)} / ${formatCpu(n.cpu_allocatable)} CPU`, p.cpu)}
                    {@render meter(`${n.memory_requests === null ? "—" : formatBytes(n.memory_requests)} / ${formatBytes(n.memory_allocatable)}`, p.memory)}
                    <span class="w-[70px] text-right font-mono text-[10px] text-[var(--text-muted)]">{n.pod_count === null ? "" : `${n.pod_count} pods`}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </CardSection>

          <CardSection title="Needs attention" icon={AlertTriangle} data-testid="overview-problems">
            {#snippet actions()}
              {#if overview.problems.length > 0}<Badge tone="error">{overview.problems.length}</Badge>{/if}
              <Button variant="link" size="inline-sm" onclick={() => openAppView("problems")}>Open problems <ArrowRight class="h-3 w-3" /></Button>
            {/snippet}
            {#if topProblems.length === 0}
              <p class="px-3 py-4 text-[12px] text-[var(--text-muted)]">Nothing is broken right now.</p>
            {:else}
              <div class="flex flex-col py-1">
                {#each topProblems as p (p.id)}
                  <button type="button" class="grid grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)_70px] items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--table-row-hover)]" onclick={() => openProblem(p)}>
                    <Badge appearance="surface" mono size="xs">{p.kind}</Badge>
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate text-[12px] text-[var(--text-primary)]">{p.name}</span>
                      {#if p.namespace}<span class="truncate font-mono text-[10px] text-[var(--text-muted)]">{p.namespace}{p.owner ? ` · ${p.owner}` : ""}</span>{/if}
                    </span>
                    <span class="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--tone)]" style={toneStyle(p.severity === "critical" ? "error" : "warning")} title={p.detail ?? p.reason}>
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tone)]"></span>
                      <span class="truncate">{p.reason}</span>
                    </span>
                    <span class="text-right font-mono text-[10px] text-[var(--text-muted)]">{p.since ? formatAge(p.since) : ""}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </CardSection>

          <CardSection title="Warnings · last hour" icon={Activity} subtitle={`${overview.warnings_total} total`} data-testid="overview-warnings">
            {#if overview.warnings.length === 0}
              <p class="px-3 py-4 text-[12px] text-[var(--text-muted)]">No Warning events in the last hour.</p>
            {:else}
              <div class="flex max-h-[300px] flex-col overflow-y-auto py-1">
                {#each overview.warnings.slice(0, 25) as w, i (i)}
                  <div class="grid grid-cols-[52px_150px_minmax(0,1fr)] items-center gap-3 px-3 py-1 text-[12px]">
                    <span class="font-mono text-[10px] text-[var(--text-muted)]">{w.last_timestamp ? formatAge(w.last_timestamp) : ""}</span>
                    <span class="truncate text-[var(--status-pending)]" title={w.reason}>{w.reason}{w.count > 1 ? ` ×${w.count}` : ""}</span>
                    <span class="truncate text-[var(--text-secondary)]" title={w.message}><span class="font-mono text-[var(--text-primary)]">{w.namespace ? `${w.namespace}/` : ""}{w.name}</span> · {w.message}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </CardSection>

          <CardSection title="Top consumers" icon={Flame} data-testid="overview-top">
            {#snippet actions()}
              <SegmentedControl ariaLabel="Top consumers by" value={topMode} onchange={(v) => (topMode = v)} items={[{ value: "cpu", label: "CPU" }, { value: "memory", label: "Memory" }]} />
            {/snippet}
            {#if !overview.metrics_available || topPods.length === 0}
              <p class="px-3 py-4 text-[12px] text-[var(--text-muted)]">metrics-server is not available — no usage data.</p>
            {:else}
              <div class="flex flex-col py-1">
                {#each topPods as pod (pod.namespace + "/" + pod.name)}
                  {@const v = topMode === "cpu" ? pod.cpu_usage : pod.memory_usage}
                  <button type="button" class="grid grid-cols-[minmax(0,1fr)_160px_80px] items-center gap-3 px-3 py-1 text-left hover:bg-[var(--table-row-hover)]" onclick={() => void openRelatedResourceTab("pods", pod.name, pod.namespace)}>
                    <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{pod.name} <span class="text-[var(--text-muted)]">{pod.namespace}</span></span>
                    <span class="h-1 rounded-full bg-[var(--bg-tertiary)]"><span class="block h-1 rounded-full bg-[var(--accent)]" style="width: {topMax ? Math.round((v / topMax) * 100) : 0}%"></span></span>
                    <span class="text-right font-mono text-[11px] text-[var(--text-secondary)]">{topMode === "cpu" ? formatCpu(v) : formatBytes(v)}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </CardSection>
        </div>
      </div>
    </ScrollArea>
  {/if}
</ViewPanel>
