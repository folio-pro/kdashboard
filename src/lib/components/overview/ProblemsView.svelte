<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Badge, Button, SearchField } from "$lib/components/ui";
  import { AlertTriangle, Bot } from "lucide-svelte";
  import { agentStore } from "$lib/stores/agent.svelte";
  import { buildProblemsSweepPrompt } from "$lib/components/agent/prompts";
  import { overviewStore } from "$lib/stores/overview.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { restartWorkload } from "$lib/actions/registry";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import { cn } from "$lib/utils";
  import type { Problem, ProblemKind, ProblemSeverity, Resource } from "$lib/types";
  import ProblemDetail from "./ProblemDetail.svelte";
  import { EMPTY_PROBLEM_FILTER, countByKind, countBySeverity, filterProblems, restartTargetFor, type ProblemFilter } from "./overview.logic";

  const KINDS: ProblemKind[] = ["Node", "Deployment", "StatefulSet", "DaemonSet", "Job", "Pod", "PersistentVolumeClaim", "Service"];

  let overview = $derived(overviewStore.overview);
  let filter = $state<ProblemFilter>({ ...EMPTY_PROBLEM_FILTER });
  let problems = $derived(overview ? filterProblems(overview.problems, filter) : []);
  let severityCounts = $derived(overview ? countBySeverity(overview.problems) : { critical: 0, warning: 0 });
  let kindCounts = $derived(overview ? countByKind(overview.problems) : {});
  let selectedId = $state<string | null>(null);
  let selected = $derived(problems.find((p) => p.id === selectedId) ?? problems[0] ?? null);

  $effect(() => {
    if (selected) overviewStore.diagnose(selected);
  });

  // Also the namespace-change reload: the header's picker scopes THIS view
  // ("" is the whole cluster, anything else one namespace), and the backend
  // keeps a short per-namespace cache.
  function handleRefresh() {
    overviewStore.loadOverview(k8sStore.currentNamespace);
  }
  function toggleSeverity(s: ProblemSeverity) {
    filter = { ...filter, severity: filter.severity === s ? null : s };
  }
  function toggleKind(k: ProblemKind) {
    filter = { ...filter, kind: filter.kind === k ? null : k };
  }
  function openDetail(p: Problem) {
    void openRelatedResourceTab(kindToResourceType(p.kind), p.name, p.namespace ?? undefined);
  }
  async function openLogs(p: Problem) {
    const pod = await k8sStore.getResource("Pod", p.name, p.namespace ?? undefined);
    if (!pod) {
      toastStore.error("Pod not found", `${p.namespace}/${p.name} is gone`);
      return;
    }
    k8sStore.selectResource(pod);
    uiStore.showLogs();
  }
  async function restart(p: Problem) {
    const t = restartTargetFor(p);
    if (!t || !p.namespace) return;
    const resource = await k8sStore.getResource(t.kind, t.name, p.namespace);
    if (!resource) {
      toastStore.error("Workload not found", `${t.kind}/${t.name}`);
      return;
    }
    try {
      await restartWorkload(resource as Resource);
      toastStore.success("Restart requested", `${t.kind}/${t.name}`);
    } catch (err) {
      toastStore.error("Restart failed", String(err));
    }
  }
</script>

<ViewPanel
  title="Problems"
  icon={AlertTriangle}
  isLoading={overviewStore.isLoading}
  error={overviewStore.error}
  hasData={!!overview}
  onRefresh={handleRefresh}
  onNamespaceChange={handleRefresh}
  loadingMessage="Looking for trouble…"
  errorMessage="Could not scan the cluster"
>
  {#snippet headerActions()}
    {#if overview && overview.problems.length > 0}
      <Button
        size="sm"
        variant="toolbar"
        title="Ask the AI agent to investigate every current problem"
        onclick={() =>
          void agentStore.quickAction(
            buildProblemsSweepPrompt(
              { context: k8sStore.currentContext, namespace: overview.namespace ?? undefined },
              overview.problems.length,
            ),
          )}
        data-testid="problems-investigate-all"
      >
        <Bot class="h-3 w-3" /> Investigate all with agent
      </Button>
    {/if}
  {/snippet}

  {#snippet badge()}
    {#if overview}
      <!-- Same scope line as Overview, always shown: a "whole cluster" that was
           silent here read as "this namespace". -->
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{overview.problems.length} active · <span data-testid="overview-scope">{overview.scope === "cluster" ? "whole cluster" : `namespace ${overview.namespace}`}</span></span>
      {#if overview.partial.length > 0}
        <Badge tone="warning" title={`Could not list: ${overview.partial.join(", ")}`}>partial</Badge>
      {/if}
    {/if}
  {/snippet}

  {#if overview}
    <div class="flex h-full min-h-0 flex-col" data-testid="problems">
      <!-- Filter strip -->
      <div class="flex h-9 shrink-0 items-center gap-1 border-b border-t border-[var(--border-color)] px-4">
        {#snippet severityButton(s: ProblemSeverity, label: string, n: number, color: string, testid: string)}
          <Button variant="muted" size="sm" class={cn("gap-2 px-2 font-normal", filter.severity === s && "bg-[var(--bg-tertiary)] text-[var(--text-primary)]")} active={filter.severity === s} activeStyle="raised" onclick={() => toggleSeverity(s)} data-testid={testid}>
            <span class="h-1.5 w-1.5 rounded-full" style:background-color={color}></span>
            {label} <span class="font-mono text-[11px] text-[var(--text-muted)]">{n}</span>
          </Button>
        {/snippet}
        {@render severityButton("critical", "Critical", severityCounts.critical, "var(--status-failed)", "filter-critical")}
        {@render severityButton("warning", "Warning", severityCounts.warning, "var(--status-pending)", "filter-warning")}
        <span class="mx-1 h-4 w-px bg-[var(--border-color)]"></span>
        {#each KINDS as k (k)}
          {#if kindCounts[k]}
            <Button variant="muted" size="sm" class={cn("gap-2 px-2 font-normal", filter.kind === k && "bg-[var(--bg-tertiary)] text-[var(--text-primary)]")} active={filter.kind === k} activeStyle="raised" onclick={() => toggleKind(k)}>
              {k} <span class="font-mono text-[11px] text-[var(--text-muted)]">{kindCounts[k]}</span>
            </Button>
          {/if}
        {/each}
        <div class="flex-1"></div>
        <SearchField value={filter.text} ariaLabel="Filter problems" placeholder="Filter by name, reason or namespace" oninput={(e: Event) => { filter = { ...filter, text: (e.target as HTMLInputElement).value }; }} class="w-[280px]" />
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]">
        <ScrollArea class="min-h-0 border-r border-[var(--border-color)]">
          {#if problems.length === 0}
            <div class="flex flex-col items-center justify-center py-20 text-center">
              <AlertTriangle class="h-4 w-4 text-[var(--text-muted)]" />
              <p class="mt-3 text-[12px] text-[var(--text-muted)]">{overview.problems.length === 0 ? "Nothing needs attention." : "No problem matches this filter."}</p>
            </div>
          {:else}
            <div class="grid h-8 grid-cols-[20px_88px_minmax(0,1.4fr)_minmax(0,1fr)_56px] items-center gap-2 border-b border-[var(--border-color)] pl-6 pr-4 text-[11px] font-medium text-[var(--text-muted)]">
              <span></span><span>Kind</span><span>Resource</span><span>Reason</span><span class="text-right">Since</span>
            </div>
            {#each problems as p (p.id)}
              {@const tone = p.severity === "critical" ? "var(--status-failed)" : "var(--status-pending)"}
              <button
                type="button"
                class={cn("grid h-11 w-full grid-cols-[20px_88px_minmax(0,1.4fr)_minmax(0,1fr)_56px] items-center gap-2 border-b border-[var(--border-color)] pl-6 pr-4 text-left hover:bg-[var(--table-row-hover)]", selected?.id === p.id && "bg-[var(--bg-secondary)]")}
                onclick={() => (selectedId = p.id)}
                ondblclick={() => openDetail(p)}
                data-testid="problem-row"
              >
                <span class="h-1.5 w-1.5 rounded-full" style:background-color={tone}></span>
                <span class="truncate font-mono text-[12px] text-[var(--text-muted)]">{p.kind}</span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{p.name}</span>
                  <span class="truncate text-[11px] text-[var(--text-muted)]">{p.namespace ?? "cluster"}{p.owner ? ` · ${p.owner}` : ""}</span>
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="truncate text-[12px]" style:color={tone}>{p.reason}{p.restarts ? ` ×${p.restarts}` : ""}</span>
                  {#if p.detail}<span class="truncate text-[11px] text-[var(--text-muted)]" title={p.detail}>{p.detail}</span>{/if}
                </span>
                <span class="text-right font-mono text-[11px] text-[var(--text-secondary)]" title={p.since ? formatTimestamp(p.since) : ""}>{p.since ? formatAge(p.since) : "—"}</span>
              </button>
            {/each}
          {/if}
        </ScrollArea>

        <ScrollArea class="min-h-0">
          {#if selected}
            <ProblemDetail
              problem={selected}
              diagnosis={overviewStore.diagnoses.get(selected.id)}
              restartTarget={restartTargetFor(selected)}
              onLogs={() => openLogs(selected!)}
              onRestart={() => restart(selected!)}
              onOpen={() => openDetail(selected!)}
            />
          {:else}
            <div class="flex h-full items-center justify-center p-6 text-center text-[12px] text-[var(--text-muted)]">Select a problem to see its detail and diagnosis.</div>
          {/if}
        </ScrollArea>
      </div>
    </div>
  {/if}
</ViewPanel>
