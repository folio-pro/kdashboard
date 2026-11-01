<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Badge, Button, CardSection, SegmentedControl, StatTile } from "$lib/components/ui";
  import { LayoutDashboard, ArrowRight } from "lucide-svelte";
  import { overviewStore } from "$lib/stores/overview.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
    import { openAppView, openRelatedResourceTab } from "$lib/actions/navigation";
  import { formatCpu, formatBytes } from "$lib/stores/metrics.logic";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { formatAge } from "$lib/utils/age";
  import { cn } from "$lib/utils";
  import type { NodeSummary, Problem } from "$lib/types";
  import { nodePressure, nodeUsage, nodeNeedsAttention, overviewTiles } from "./overview.logic";

  let overview = $derived(overviewStore.overview);
  let tiles = $derived(overview ? overviewTiles(overview) : []);
  let topProblems = $derived(overview ? overview.problems.slice(0, 6) : []);
  let topMode = $state<"cpu" | "memory">("cpu");
  let topPods = $derived(overview ? (topMode === "cpu" ? overview.top_pods_cpu : overview.top_pods_memory) : []);
  let topMax = $derived(topPods.reduce((m, p) => Math.max(m, topMode === "cpu" ? p.cpu_usage : p.memory_usage), 0));

  // Also the namespace-change reload: the header's picker scopes THIS view
  // ("" is the whole cluster, anything else one namespace), and the backend
  // keeps a short per-namespace cache.
  function handleRefresh() {
    overviewStore.loadOverview(k8sStore.currentNamespace);
  }
  function openProblem(p: Problem) {
    void openRelatedResourceTab(kindToResourceType(p.kind), p.name, p.namespace ?? undefined);
  }
  function openNode(n: NodeSummary) {
    void openRelatedResourceTab("nodes", n.name);
  }
  /** Colour only past a threshold: a healthy node is the quiet case. */
  function hotColor(percent: number | null): string | null {
    if (percent === null) return null;
    if (percent > 90) return "var(--status-failed)";
    if (percent > 75) return "var(--status-pending)";
    return null;
  }
  function ticks(color: string): string {
    return `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 4px)`;
  }
</script>

<!-- A level meter, as on an instrument panel: faint track, dim for what is
     requested, bright for what is really used. -->
{#snippet meter(label: string, percent: number | null, used: number | null)}
  {@const hot = hotColor(percent)}
  <span class="flex min-w-0 flex-col gap-1">
    <span class="flex justify-between gap-2 whitespace-nowrap font-mono text-[11px] text-[var(--text-muted)]">
      <span class="truncate">{label}</span>
      <span style:color={hot ?? "var(--text-secondary)"}>{percent === null ? "" : `${percent}%`}</span>
    </span>
    <span class="relative block h-3" style:background={ticks("var(--bg-tertiary)")} role="img" aria-label={`Requests ${percent ?? "unknown"}%, usage ${used ?? "unknown"}%`}>
      <span class="absolute inset-y-0 left-0" style:width="{Math.min(percent ?? 0, 100)}%" style:background={ticks(hot ? `color-mix(in srgb, ${hot} 45%, var(--bg-secondary))` : "color-mix(in srgb, var(--text-primary) 30%, var(--bg-secondary))")}></span>
      <span class="absolute inset-y-0 left-0" style:width="{Math.min(used ?? 0, 100)}%" style:background={ticks(hot ?? "var(--text-primary)")}></span>
    </span>
  </span>
{/snippet}

<ViewPanel
  title="Overview"
  icon={LayoutDashboard}
  isLoading={overviewStore.isLoading}
  error={overviewStore.error}
  hasData={!!overview}
  onRefresh={handleRefresh}
  onNamespaceChange={handleRefresh}
  loadingMessage="Reading the cluster…"
  errorMessage="Could not build the overview"
>
  {#snippet badge()}
    {#if overview}
      <!-- Same scope badge as Problems: what the data covers, in the words the
           picker beside it uses. -->
      <span class="font-mono text-[11px] text-[var(--text-muted)]" data-testid="overview-scope">
        {overview.scope === "cluster" ? "whole cluster" : `namespace ${overview.namespace}`}
      </span>
      {#if overview.partial.length > 0}
        <Badge tone="warning" title={`Could not list: ${overview.partial.join(", ")}`}>partial</Badge>
      {/if}
    {/if}
  {/snippet}

  {#if overview}
    <ScrollArea class="h-full">
      <div class="flex flex-col gap-3 px-6 py-3" data-testid="overview">
        <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {#each tiles as tile (tile.label)}
            <!-- Only Problems colours its number: the count is the news there,
                 and everywhere else the dot says what the note means. -->
            <StatTile label={tile.label} value={tile.value} note={tile.note} tone={tile.tone === "neutral" ? "neutral" : tile.tone} toneValue={tile.label === "Problems"} size="lg" dot data-testid="overview-tile" />
          {/each}
        </div>

        <div class="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardSection title="Nodes" subtitle="over allocatable" data-testid="overview-nodes">
            {#snippet actions()}
              <span class="flex gap-3 text-[11px] text-[var(--text-muted)]">
                <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-[2px] bg-[var(--text-primary)]"></span>usage</span>
                <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-[2px] bg-[color-mix(in_srgb,var(--text-primary)_30%,var(--bg-secondary))]"></span>requests</span>
              </span>
            {/snippet}
            {#if overview.nodes.length === 0}
              <p class="px-4 py-4 text-[12px] text-[var(--text-muted)]">Nodes are not listable with these credentials.</p>
            {:else}
              <div class="flex flex-col py-1">
                {#each overview.nodes as n (n.name)}
                  {@const p = nodePressure(n)}
                  {@const u = nodeUsage(n)}
                  <button
                    type="button"
                    class="grid grid-cols-[minmax(120px,1fr)_minmax(0,2fr)_minmax(0,2fr)_56px] items-center gap-4 px-4 py-2 text-left hover:bg-[var(--table-row-hover)]"
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
                    {@render meter(`${n.cpu_requests === null ? "—" : formatCpu(n.cpu_requests)} / ${formatCpu(n.cpu_allocatable)} CPU`, p.cpu, u.cpu)}
                    {@render meter(`${n.memory_requests === null ? "—" : formatBytes(n.memory_requests)} / ${formatBytes(n.memory_allocatable)}`, p.memory, u.memory)}
                    <span class="whitespace-nowrap text-right font-mono text-[11px] text-[var(--text-muted)]">{n.pod_count === null ? "" : `${n.pod_count} pods`}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </CardSection>

          <CardSection title="Needs attention" data-testid="overview-problems">
            {#snippet actions()}
              <Button variant="muted" size="inline-sm" class="hover:bg-transparent" onclick={() => openAppView("problems")}>
                Open problems
                {#if overview.problems.length > 0}<span class="font-mono text-[11px] text-[var(--status-failed)]">{overview.problems.length}</span>{/if}
                <ArrowRight class="h-3 w-3" />
              </Button>
            {/snippet}
            {#if topProblems.length === 0}
              <p class="px-4 py-4 text-[12px] text-[var(--text-muted)]">Nothing is broken right now.</p>
            {:else}
              <div class="flex flex-col py-1">
                {#each topProblems as p (p.id)}
                  {@const tone = p.severity === "critical" ? "var(--status-failed)" : "var(--status-pending)"}
                  <button type="button" class="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-4 py-2 text-left hover:bg-[var(--table-row-hover)]" onclick={() => openProblem(p)} title={p.detail ?? p.reason}>
                    <span class="h-1.5 w-1.5 rounded-full" style:background-color={tone}></span>
                    <span class="truncate text-[12px] text-[var(--text-primary)]">{p.name}</span>
                    <span class="font-mono text-[11px] text-[var(--text-muted)]">{p.since ? formatAge(p.since) : ""}</span>
                    <span></span>
                    <span class="col-span-2 truncate text-[11px] text-[var(--text-muted)]"><span style:color={tone}>{p.reason}</span> · {p.kind}{p.namespace ? ` · ${p.namespace}` : ""}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </CardSection>

          <CardSection title="Warnings · last hour" subtitle={`${overview.warnings_total} total`} data-testid="overview-warnings">
            {#if overview.warnings.length === 0}
              <p class="px-4 py-4 text-[12px] text-[var(--text-muted)]">No Warning events in the last hour.</p>
            {:else}
              <div class="flex max-h-[300px] flex-col overflow-y-auto py-1">
                {#each overview.warnings.slice(0, 25) as w, i (i)}
                  <div class="grid h-7 shrink-0 grid-cols-[32px_112px_minmax(0,1fr)] items-center gap-3 px-4 text-[12px]">
                    <span class="font-mono text-[11px] text-[var(--text-muted)]">{w.last_timestamp ? formatAge(w.last_timestamp) : ""}</span>
                    <span class="truncate text-[var(--status-pending)]" title={w.reason}>{w.reason}{#if w.count > 1} <span class="font-mono text-[11px]">×{w.count}</span>{/if}</span>
                    <span class="truncate text-[var(--text-secondary)]" title={w.message}><span class="font-mono text-[var(--text-primary)]">{w.namespace ? `${w.namespace}/` : ""}{w.name}</span> · {w.message}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </CardSection>

          <CardSection title="Top consumers" data-testid="overview-top">
            {#snippet actions()}
              <SegmentedControl ariaLabel="Top consumers by" value={topMode} onchange={(v) => (topMode = v)} items={[{ value: "cpu", label: "CPU" }, { value: "memory", label: "Memory" }]} />
            {/snippet}
            {#if !overview.metrics_available || topPods.length === 0}
              <p class="px-4 py-4 text-[12px] text-[var(--text-muted)]">metrics-server is not available — no usage data.</p>
            {:else}
              <div class="flex flex-col py-1">
                {#each topPods as pod (pod.namespace + "/" + pod.name)}
                  {@const v = topMode === "cpu" ? pod.cpu_usage : pod.memory_usage}
                  <button type="button" class="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_64px_48px] items-center gap-3 px-4 text-left hover:bg-[var(--table-row-hover)]" onclick={() => void openRelatedResourceTab("pods", pod.name, pod.namespace)} title={`${pod.namespace}/${pod.name}`}>
                    <span class="truncate text-[12px] text-[var(--text-primary)]">{pod.name}</span>
                    <span class="h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"><span class="block h-1 rounded-full bg-[color-mix(in_srgb,var(--text-primary)_38%,var(--bg-primary))]" style="width: {topMax ? Math.round((v / topMax) * 100) : 0}%"></span></span>
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
