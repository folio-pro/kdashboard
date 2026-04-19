<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { openResourceDetail } from "$lib/actions/navigation";
  import { formatAge } from "$lib/utils/age";
  import { classifyPodStatus, getTotalRestarts } from "$lib/utils/workload-stats";
  import { getContainerState } from "$lib/utils/k8s-helpers";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { Resource, ResourceList, Event as K8sEvent } from "$lib/types";
  import {
    AlertTriangle, CheckCircle2, Server, Box, Layers, Globe,
    Network, FileText, Activity, ChevronRight, RefreshCw,
  } from "lucide-svelte";

  let pods = $state<Resource[]>([]);
  let nodes = $state<Resource[]>([]);
  let events = $state<K8sEvent[]>([]);
  let isLoading = $state(true);
  let loadError = $state<string | null>(null);

  // Cache whether cluster-wide listing works (avoids repeated RBAC failures)
  let clusterWideAllowed: boolean | null = null;

  interface IssueItem {
    kind: string;
    name: string;
    namespace: string;
    reason: string;
    restarts: number;
    resource: Resource;
  }

  // Single pass over pods: compute counts + collect issues
  let podAnalysis = $derived.by(() => {
    let running = 0, pending = 0, failed = 0, succeeded = 0;
    const issueItems: IssueItem[] = [];
    for (const pod of pods) {
      const status = classifyPodStatus(pod);
      if (status === "running") running++;
      else if (status === "succeeded") succeeded++;
      else {
        if (status === "pending") pending++;
        else if (status === "failed") failed++;
        const cs = pod.status?.containerStatuses as Array<{ state?: Record<string, unknown> }> | undefined;
        let reason = status === "failed" ? "Error" : "Pending";
        if (cs) {
          for (const c of cs) {
            if (c.state && (c.state.waiting || c.state.terminated)) {
              reason = getContainerState(c.state);
              break;
            }
          }
        }
        issueItems.push({
          kind: "Pod",
          name: pod.metadata.name,
          namespace: pod.metadata.namespace ?? "",
          reason,
          restarts: getTotalRestarts(pod),
          resource: pod,
        });
      }
    }
    issueItems.sort((a, b) => b.restarts - a.restarts);
    return {
      running, pending, failed, succeeded,
      total: pods.length,
      issues: issueItems.slice(0, 5),
    };
  });

  let issues = $derived(podAnalysis.issues);
  let podCounts = $derived(podAnalysis);

  let nodeHealthy = $derived(nodes.filter((n) => {
    const conditions = n.status?.conditions as Array<{ type: string; status: string }> | undefined;
    return conditions?.some((c) => c.type === "Ready" && c.status === "True");
  }).length);

  let healthPercent = $derived(
    podCounts.total > 0
      ? Math.round(((podCounts.running + podCounts.succeeded) / podCounts.total) * 100)
      : 100
  );

  let recentEvents = $derived(events.slice(0, 10));
  let warningCount = $derived(events.reduce((n, e) => n + (e.type === "Warning" ? 1 : 0), 0));
  let counts = $derived(k8sStore.resourceCounts);

  // Update dock badge with error pod count
  $effect(() => {
    const errorCount = podCounts.failed + podCounts.pending;
    getCurrentWindow().setBadgeCount(errorCount > 0 ? errorCount : undefined).catch(() => {});
  });

  async function loadOverviewData() {
    isLoading = true;
    loadError = null;
    try {
      const ns = k8sStore.currentNamespace || null;
      let podResult: ResourceList;
      if (clusterWideAllowed === false) {
        podResult = await invoke<ResourceList>("list_resources", { resourceType: "pods", namespace: ns });
      } else {
        try {
          podResult = await invoke<ResourceList>("list_resources", { resourceType: "pods", namespace: null });
          clusterWideAllowed = true;
        } catch {
          clusterWideAllowed = false;
          podResult = await invoke<ResourceList>("list_resources", { resourceType: "pods", namespace: ns });
        }
      }
      const [nodeResult, eventResult] = await Promise.all([
        invoke<ResourceList>("list_resources", { resourceType: "nodes", namespace: null }).catch(() => ({ items: [], resource_type: "nodes" })),
        invoke<K8sEvent[]>("get_events", { namespace: ns, fieldSelector: null }).catch(() => []),
      ]);
      pods = podResult.items;
      nodes = nodeResult.items;
      events = eventResult;
    } catch (err) {
      loadError = String(err);
    } finally {
      isLoading = false;
    }
  }

  // Load data on mount and re-load on context switch
  $effect(() => {
    void k8sStore.currentContext;
    clusterWideAllowed = null;
    loadOverviewData();
  });

  function navigateToIssue(issue: IssueItem) {
    openResourceDetail(issue.resource, "pods");
  }

  function navigateToResource(type: string) {
    k8sStore.loadResources(type);
    uiStore.backToTable();
  }

  function getEventAge(event: K8sEvent): string {
    const ts = event.last_timestamp ?? event.first_timestamp;
    if (!ts) return "";
    return formatAge(ts);
  }
</script>

<div class="flex h-full flex-col overflow-hidden bg-[var(--bg-primary)]">
  <!-- Header -->
  <div class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6" data-tauri-drag-region>
    <div class="flex items-center gap-2" data-tauri-drag-region>
      <Activity class="h-4 w-4 text-[var(--accent)]" />
      <span class="text-sm font-semibold text-[var(--text-primary)]">Cluster Overview</span>
      {#if k8sStore.currentContext}
        <span class="text-xs text-[var(--text-muted)]">{k8sStore.currentContext}</span>
      {/if}
    </div>
    <button
      class="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      onclick={loadOverviewData}
      title="Refresh"
    >
      <RefreshCw class="h-3.5 w-3.5" />
    </button>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto p-6">
    {#if loadError}
      <!-- Error state -->
      <div class="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <AlertTriangle class="h-8 w-8 text-[var(--status-failed)]" />
        <p class="text-sm text-[var(--text-primary)]">Can't reach cluster</p>
        <p class="max-w-md text-xs text-[var(--text-muted)]">{loadError}</p>
        <button
          class="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110"
          onclick={loadOverviewData}
        >Retry</button>
      </div>
    {:else}
      <div class="mx-auto flex max-w-4xl flex-col gap-5">

        <!-- Issues Section (top priority) -->
        {#if isLoading}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <Skeleton class="mb-3 h-4 w-48" />
            <div class="flex flex-col gap-2">
              <Skeleton class="h-10 w-full" />
              <Skeleton class="h-10 w-full" />
            </div>
          </div>
        {:else if issues.length > 0}
          <div class="rounded-lg border border-[var(--status-failed)]/20 bg-[var(--bg-secondary)] p-4">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <AlertTriangle class="h-4 w-4 text-[var(--status-failed)]" />
                <span class="text-xs font-semibold text-[var(--text-primary)]">Issues Requiring Attention ({issues.length})</span>
              </div>
              <button
                class="flex items-center gap-1 text-[10px] text-[var(--accent)] transition-colors hover:underline"
                onclick={() => navigateToResource("pods")}
              >View All<ChevronRight class="h-3 w-3" /></button>
            </div>
            <div class="flex flex-col gap-1.5">
              {#each issues as issue}
                <button
                  class="flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                  onclick={() => navigateToIssue(issue)}
                >
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--status-failed)]"></span>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-primary)]">{issue.kind.toLowerCase()}/{issue.name}</span>
                  <span class="shrink-0 text-[10px] text-[var(--status-failed)]">{issue.reason}</span>
                  {#if issue.restarts > 0}
                    <span class="shrink-0 text-[10px] text-[var(--text-muted)]">{issue.restarts} restarts</span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {:else}
          <!-- All clear state -->
          <div class="rounded-lg border border-[var(--status-running)]/20 bg-[var(--bg-secondary)] p-4">
            <div class="flex items-center gap-2">
              <CheckCircle2 class="h-4 w-4 text-[var(--status-running)]" />
              <span class="text-xs font-semibold text-[var(--text-primary)]">All Clear</span>
              <span class="text-xs text-[var(--text-muted)]">No issues detected</span>
            </div>
          </div>
        {/if}

        <!-- Health Row -->
        <div class="grid grid-cols-2 gap-4">
          <!-- Node Health -->
          {#if isLoading}
            <Skeleton class="h-20 rounded-lg" />
          {:else}
            <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
              <div class="mb-2 flex items-center gap-2">
                <Server class="h-3.5 w-3.5 text-[var(--text-muted)]" />
                <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Nodes</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-2xl font-bold tabular-nums text-[var(--text-primary)]">{nodeHealthy}/{nodes.length}</span>
                <span class="text-xs text-[var(--text-muted)]">ready</span>
                {#if nodeHealthy === nodes.length && nodes.length > 0}
                  <CheckCircle2 class="ml-auto h-4 w-4 text-[var(--status-running)]" />
                {:else if nodes.length > 0}
                  <AlertTriangle class="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                {/if}
              </div>
            </div>
          {/if}

          <!-- Pod Health -->
          {#if isLoading}
            <Skeleton class="h-20 rounded-lg" />
          {:else}
            <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
              <div class="mb-2 flex items-center gap-2">
                <Box class="h-3.5 w-3.5 text-[var(--text-muted)]" />
                <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Pods</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-2xl font-bold tabular-nums text-[var(--text-primary)]">{podCounts.running}/{podCounts.total}</span>
                <div class="flex flex-1 items-center gap-1">
                  <!-- Health bar -->
                  <div class="h-2 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                    {#if podCounts.total > 0}
                      <div
                        class="h-full rounded-full bg-[var(--status-running)] transition-all duration-500"
                        style="width: {healthPercent}%"
                      ></div>
                    {/if}
                  </div>
                  <span class="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{healthPercent}%</span>
                </div>
              </div>
              {#if podCounts.failed > 0 || podCounts.pending > 0}
                <div class="mt-1.5 flex gap-3 text-[10px]">
                  {#if podCounts.failed > 0}
                    <span class="text-[var(--status-failed)]">{podCounts.failed} failed</span>
                  {/if}
                  {#if podCounts.pending > 0}
                    <span class="text-[var(--status-pending)]">{podCounts.pending} pending</span>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Resource Counts -->
        {#if isLoading}
          <Skeleton class="h-16 rounded-lg" />
        {:else}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <div class="mb-2">
              <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Resources</span>
            </div>
            <div class="flex flex-wrap gap-x-6 gap-y-1">
              {#each [
                { label: "Pods", type: "pods", icon: Box, count: counts.pods },
                { label: "Deployments", type: "deployments", icon: Layers, count: counts.deployments },
                { label: "Services", type: "services", icon: Globe, count: counts.services },
                { label: "Ingresses", type: "ingresses", icon: Network, count: counts.ingresses },
                { label: "ConfigMaps", type: "configmaps", icon: FileText, count: counts.configmaps },
              ] as item}
                {@const Icon = item.icon}
                <button
                  class="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors hover:bg-[var(--bg-tertiary)]"
                  onclick={() => navigateToResource(item.type)}
                  title="View {item.label}"
                >
                  <Icon class="h-3 w-3 text-[var(--text-muted)]" />
                  <span class="text-[var(--text-secondary)]">{item.label}</span>
                  <span class="font-semibold tabular-nums text-[var(--text-primary)]">{item.count ?? 0}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Recent Events -->
        {#if isLoading}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <Skeleton class="mb-3 h-4 w-32" />
            <div class="flex flex-col gap-2">
              {#each Array(4) as _}
                <Skeleton class="h-5 w-full" />
              {/each}
            </div>
          </div>
        {:else if recentEvents.length > 0}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <div class="mb-3 flex items-center justify-between">
              <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Recent Events</span>
              {#if warningCount > 0}
                <span class="text-[10px] text-[var(--status-warning)]">{warningCount} warnings</span>
              {/if}
            </div>
            <table class="w-full table-fixed text-[11px]">
              <thead>
                <tr class="text-left text-[var(--text-dimmed)]">
                  <th class="w-16 pb-1.5 pr-3 font-medium">Age</th>
                  <th class="w-16 pb-1.5 pr-3 font-medium">Type</th>
                  <th class="w-28 pb-1.5 pr-3 font-medium">Reason</th>
                  <th class="pb-1.5 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {#each recentEvents as event}
                  <tr class="border-t border-[var(--border-color)]">
                    <td class="whitespace-nowrap py-1.5 pr-3 tabular-nums text-[var(--text-dimmed)]">{getEventAge(event)}</td>
                    <td class="whitespace-nowrap py-1.5 pr-3 {event.type === 'Warning' ? 'text-[var(--status-warning)]' : 'text-[var(--text-muted)]'}">{event.type}</td>
                    <td class="whitespace-nowrap py-1.5 pr-3 font-medium text-[var(--text-secondary)]">{event.reason}</td>
                    <td class="w-full truncate py-1.5 text-[var(--text-muted)]">{event.message}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <span class="text-xs text-[var(--text-muted)]">No recent events</span>
          </div>
        {/if}

        <!-- Empty cluster state -->
        {#if !isLoading && pods.length === 0 && nodes.length === 0}
          <div class="flex flex-col items-center gap-3 py-8 text-center">
            <Box class="h-10 w-10 text-[var(--text-dimmed)]" />
            <p class="text-sm text-[var(--text-secondary)]">Your cluster is empty</p>
            <p class="max-w-sm text-xs text-[var(--text-muted)]">Deploy your first app to see health metrics, issues, and events here.</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
