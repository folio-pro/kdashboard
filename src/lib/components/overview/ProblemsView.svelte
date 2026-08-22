<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Badge, Button, SearchField } from "$lib/components/ui";
  import { AlertTriangle } from "lucide-svelte";
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

  const KINDS: ProblemKind[] = ["Node", "Deployment", "StatefulSet", "DaemonSet", "Job", "Pod"];

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

  function handleBack() {
    uiStore.backToPrevious();
  }
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
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Looking for trouble…"
  errorMessage="Could not scan the cluster"
>
  {#snippet badge()}
    {#if overview}
      <Badge tone={overview.problems.length === 0 ? "success" : severityCounts.critical > 0 ? "error" : "warning"}>{overview.problems.length} active</Badge>
      {#if overview.scope === "namespace"}<Badge tone="warning">namespace {overview.namespace}</Badge>{/if}
    {/if}
  {/snippet}

  {#if overview}
    <div class="flex h-full min-h-0 flex-col" data-testid="problems">
      <!-- Filter strip -->
      <div class="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-4">
        <Button variant="soft-tone" tone="error" size="xs" active={filter.severity === "critical"} activeStyle="soft" onclick={() => toggleSeverity("critical")} data-testid="filter-critical">
          Critical <span class="font-mono opacity-70">{severityCounts.critical}</span>
        </Button>
        <Button variant="soft-tone" tone="warning" size="xs" active={filter.severity === "warning"} activeStyle="soft" onclick={() => toggleSeverity("warning")} data-testid="filter-warning">
          Warning <span class="font-mono opacity-70">{severityCounts.warning}</span>
        </Button>
        <span class="h-3 w-px bg-[var(--border-color)]"></span>
        {#each KINDS as k (k)}
          {#if kindCounts[k]}
            <Button variant="outline" size="xs" active={filter.kind === k} activeStyle="underline" onclick={() => toggleKind(k)}>
              {k} <span class="font-mono text-[var(--text-muted)]">{kindCounts[k]}</span>
            </Button>
          {/if}
        {/each}
        <div class="flex-1"></div>
        <SearchField value={filter.text} ariaLabel="Filter problems" placeholder="Filter by name, reason or namespace" oninput={(e: Event) => { filter = { ...filter, text: (e.target as HTMLInputElement).value }; }} class="w-[260px]" />
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]">
        <ScrollArea class="min-h-0 border-r border-[var(--border-color)]">
          {#if problems.length === 0}
            <div class="flex flex-col items-center justify-center py-20 text-center">
              <AlertTriangle class="h-6 w-6 text-[var(--text-muted)]" />
              <p class="mt-3 text-[12px] text-[var(--text-muted)]">{overview.problems.length === 0 ? "Nothing needs attention." : "No problem matches this filter."}</p>
            </div>
          {:else}
            <div class="grid grid-cols-[20px_72px_minmax(0,1.4fr)_minmax(0,1fr)_70px] items-center gap-3 bg-[var(--table-header-bg)] px-4 py-1.5 text-[11px] text-[var(--text-muted)]">
              <span></span><span>Kind</span><span>Resource</span><span>Reason</span><span>Since</span>
            </div>
            {#each problems as p (p.id)}
              <button
                type="button"
                class={cn("grid w-full grid-cols-[20px_72px_minmax(0,1.4fr)_minmax(0,1fr)_70px] items-center gap-3 border-b border-[var(--border-color)] px-4 py-2 text-left hover:bg-[var(--table-row-hover)]", selected?.id === p.id && "bg-[var(--sidebar-active)]")}
                onclick={() => (selectedId = p.id)}
                ondblclick={() => openDetail(p)}
                data-testid="problem-row"
              >
                <span class={cn("h-2 w-2 rounded-full", p.severity === "critical" ? "bg-[var(--status-failed)]" : "bg-[var(--status-pending)]")}></span>
                <Badge appearance="surface" mono size="xs">{p.kind}</Badge>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{p.name}</span>
                  <span class="truncate text-[11px] text-[var(--text-muted)]">{p.namespace ?? "cluster"}{p.owner ? ` · ${p.owner}` : ""}</span>
                </span>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate text-[12px] text-[var(--text-primary)]">{p.reason}{p.restarts ? ` ×${p.restarts}` : ""}</span>
                  {#if p.detail}<span class="truncate text-[11px] text-[var(--text-muted)]" title={p.detail}>{p.detail}</span>{/if}
                </span>
                <span class="font-mono text-[11px] text-[var(--text-secondary)]" title={p.since ? formatTimestamp(p.since) : ""}>{p.since ? formatAge(p.since) : "—"}</span>
              </button>
            {/each}
          {/if}
        </ScrollArea>

        <ScrollArea class="min-h-0 bg-[var(--bg-secondary)]">
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
