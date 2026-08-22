<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Badge, Button, SearchField } from "$lib/components/ui";
  import { AlertTriangle, ScrollText, ExternalLink, RefreshCw, Stethoscope } from "lucide-svelte";
  import { overviewStore } from "$lib/stores/overview.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { invoke } from "$lib/ipc/core";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { restartWorkload } from "$lib/actions/registry";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import { cn } from "$lib/utils";
  import type { DiagnosticResult, Problem, ProblemKind, ProblemSeverity, Resource } from "$lib/types";
  import { EMPTY_PROBLEM_FILTER, countByKind, countBySeverity, filterProblems, problemResourceType, type ProblemFilter } from "./overview.logic";

  let overview = $derived(overviewStore.overview);
  let filter = $state<ProblemFilter>({ ...EMPTY_PROBLEM_FILTER });
  let problems = $derived(overview ? filterProblems(overview.problems, filter) : []);
  let severityCounts = $derived(overview ? countBySeverity(overview.problems) : { critical: 0, warning: 0 });
  let kindCounts = $derived(overview ? countByKind(overview.problems) : {});
  let selectedId = $state<string | null>(null);
  let selected = $derived(problems.find((p) => p.id === selectedId) ?? problems[0] ?? null);

  // Diagnosis for the selected problem, fetched lazily and cached per id.
  let diagnosis = $state<Record<string, DiagnosticResult | { error: string } | "loading">>({});
  $effect(() => {
    const p = selected;
    if (!p || diagnosis[p.id]) return;
    diagnosis = { ...diagnosis, [p.id]: "loading" };
    invoke<DiagnosticResult>("diagnose_resource", { kind: p.kind, name: p.name, namespace: p.namespace ?? "" })
      .then((r) => { diagnosis = { ...diagnosis, [p.id]: r }; })
      .catch((err) => { diagnosis = { ...diagnosis, [p.id]: { error: String(err) } }; });
  });

  function handleBack() {
    uiStore.backToPrevious();
  }
  function handleRefresh() {
    diagnosis = {};
    overviewStore.loadOverview(k8sStore.currentNamespace);
  }
  function toggleSeverity(s: ProblemSeverity) {
    filter = { ...filter, severity: filter.severity === s ? null : s };
  }
  function toggleKind(k: ProblemKind) {
    filter = { ...filter, kind: filter.kind === k ? null : k };
  }
  function openDetail(p: Problem) {
    void openRelatedResourceTab(problemResourceType(p.kind), p.name, p.namespace ?? undefined);
  }
  async function openLogs(p: Problem) {
    const pod = await k8sStore.fetchResource("pods", p.name, p.namespace ?? undefined);
    if (!pod) {
      toastStore.error("Pod not found", `${p.namespace}/${p.name} is gone`);
      return;
    }
    k8sStore.selectResource(pod);
    uiStore.showLogs();
  }
  /** The workload to restart for a problem: the Deployment/STS/DS itself, or a pod's owner. */
  function restartTarget(p: Problem): { kind: string; name: string } | null {
    if (p.kind === "Deployment" || p.kind === "StatefulSet" || p.kind === "DaemonSet") return { kind: p.kind, name: p.name };
    if (p.kind === "Pod" && p.owner) {
      const [kind, name] = p.owner.split("/");
      if (kind === "ReplicaSet") {
        const idx = name.lastIndexOf("-");
        return idx > 0 ? { kind: "Deployment", name: name.slice(0, idx) } : null;
      }
      if (kind === "StatefulSet" || kind === "DaemonSet") return { kind, name };
    }
    return null;
  }
  async function restart(p: Problem) {
    const t = restartTarget(p);
    if (!t || !p.namespace) return;
    const resource = await k8sStore.resolveResourceByRef(t.kind, t.name, p.namespace);
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

  const KINDS: ProblemKind[] = ["Node", "Deployment", "StatefulSet", "DaemonSet", "Job", "Pod"];
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
        <button type="button" class={cn("flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[12px]", filter.severity === "critical" ? "bg-[color-mix(in_srgb,var(--status-failed)_18%,transparent)] text-[var(--text-primary)]" : "bg-[color-mix(in_srgb,var(--status-failed)_8%,transparent)] text-[var(--text-secondary)]")} onclick={() => toggleSeverity("critical")} data-testid="filter-critical">
          <span class="h-1.5 w-1.5 rounded-full bg-[var(--status-failed)]"></span>Critical <span class="font-mono text-[var(--text-muted)]">{severityCounts.critical}</span>
        </button>
        <button type="button" class={cn("flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[12px]", filter.severity === "warning" ? "bg-[color-mix(in_srgb,var(--status-pending)_18%,transparent)] text-[var(--text-primary)]" : "bg-[color-mix(in_srgb,var(--status-pending)_8%,transparent)] text-[var(--text-secondary)]")} onclick={() => toggleSeverity("warning")} data-testid="filter-warning">
          <span class="h-1.5 w-1.5 rounded-full bg-[var(--status-pending)]"></span>Warning <span class="font-mono text-[var(--text-muted)]">{severityCounts.warning}</span>
        </button>
        <span class="h-3 w-px bg-[var(--border-color)]"></span>
        {#each KINDS as k (k)}
          {#if kindCounts[k]}
            <button type="button" class={cn("flex h-6 items-center gap-1 rounded-md border px-2 text-[11px]", filter.kind === k ? "border-[var(--accent)] text-[var(--text-primary)]" : "border-[var(--border-color)] text-[var(--text-secondary)]")} onclick={() => toggleKind(k)}>
              {k} <span class="font-mono text-[var(--text-muted)]">{kindCounts[k]}</span>
            </button>
          {/if}
        {/each}
        <div class="flex-1"></div>
        <SearchField value={filter.text} ariaLabel="Filter problems" placeholder="Filter by name, reason or namespace" oninput={(e: Event) => { filter = { ...filter, text: (e.target as HTMLInputElement).value }; }} class="w-[260px]" />
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]">
        <!-- List -->
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
                <span class="truncate rounded-sm bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-center font-mono text-[10px] text-[var(--text-muted)]">{p.kind}</span>
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

        <!-- Detail aside -->
        <ScrollArea class="min-h-0 bg-[var(--bg-secondary)]">
          {#if selected}
            {@const d = diagnosis[selected.id]}
            {@const rt = restartTarget(selected)}
            <div class="flex flex-col gap-4 p-4 text-[12px]" data-testid="problem-detail">
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
                  <span class={cn("h-2 w-2 rounded-full", selected.severity === "critical" ? "bg-[var(--status-failed)]" : "bg-[var(--status-pending)]")}></span>
                  <span class="truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">{selected.name}</span>
                </div>
                <span class="text-[11px] text-[var(--text-muted)]">{selected.kind}{selected.namespace ? ` · ${selected.namespace}` : ""}{selected.owner ? ` · owned by ${selected.owner}` : ""}</span>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  {#if selected.kind === "Pod"}
                    <Button size="sm" variant="accent" onclick={() => openLogs(selected)}><ScrollText class="h-3 w-3" /> Logs</Button>
                  {/if}
                  {#if rt && selected.namespace}
                    <Button size="sm" variant="outline" onclick={() => restart(selected)}><RefreshCw class="h-3 w-3" /> Restart {rt.kind.toLowerCase()}</Button>
                  {/if}
                  <Button size="sm" variant="outline" onclick={() => openDetail(selected)}><ExternalLink class="h-3 w-3" /> Open detail</Button>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <span class="text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">What is wrong</span>
                <div class={cn("rounded-md border px-3 py-2", selected.severity === "critical" ? "border-[color-mix(in_srgb,var(--status-failed)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-failed)_8%,transparent)]" : "border-[color-mix(in_srgb,var(--status-pending)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-pending)_8%,transparent)]")}>
                  <div class="font-medium text-[var(--text-primary)]">{selected.reason}{selected.ready !== null && selected.desired !== null ? ` · ${selected.ready}/${selected.desired} ready` : ""}</div>
                  {#if selected.detail}<div class="mt-1 leading-relaxed text-[var(--text-secondary)]">{selected.detail}</div>{/if}
                  {#if selected.restarts}<div class="mt-1 text-[11px] text-[var(--text-muted)]">{selected.restarts} restarts</div>{/if}
                  {#if selected.since}<div class="mt-1 text-[11px] text-[var(--text-muted)]">since {formatTimestamp(selected.since)} ({formatAge(selected.since)})</div>{/if}
                </div>
              </div>

              <div class="flex flex-col gap-1.5" data-testid="problem-diagnosis">
                <span class="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]"><Stethoscope class="h-3 w-3" /> Diagnosis</span>
                {#if !d || d === "loading"}
                  <span class="text-[var(--text-muted)]">Checking…</span>
                {:else if "error" in d}
                  <span class="text-[var(--text-muted)]">Not available: {d.error}</span>
                {:else if d.issues.length === 0}
                  <span class="text-[var(--text-muted)]">The diagnostics found nothing beyond the status above.</span>
                {:else}
                  <ul class="flex flex-col gap-2">
                    {#each d.issues as issue, i (i)}
                      <li class="rounded-md border border-[var(--border-color)] px-3 py-2">
                        <div class="flex items-center gap-2">
                          <Badge tone={issue.severity === "critical" ? "error" : issue.severity === "warning" ? "warning" : "info"}>{issue.severity}</Badge>
                          <span class="font-medium text-[var(--text-primary)]">{issue.title}</span>
                        </div>
                        <div class="mt-1 leading-relaxed text-[var(--text-secondary)]">{issue.detail}</div>
                        {#if issue.suggestion}<div class="mt-1 text-[11px] text-[var(--accent)]">→ {issue.suggestion}</div>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </div>
          {:else}
            <div class="flex h-full items-center justify-center p-6 text-center text-[12px] text-[var(--text-muted)]">Select a problem to see its detail and diagnosis.</div>
          {/if}
        </ScrollArea>
      </div>
    </div>
  {/if}
</ViewPanel>
