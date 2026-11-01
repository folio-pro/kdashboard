<script lang="ts">
  import { Button } from "$lib/components/ui";
  import { ArrowRight, ScrollText, ExternalLink, RefreshCw, FileCode, Box, Bot } from "lucide-svelte";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import type { DiagnosisVerdict, PodRef, Problem } from "$lib/types";
  import type { WorkloadRef } from "$lib/utils/pod-status";
  import type { Diagnosis } from "$lib/stores/overview.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { openRelatedResourceTab, openResourceDetail } from "$lib/actions/navigation";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { CAUSE_LABEL, problemActions } from "./overview.logic";
  import { agentStore } from "$lib/stores/agent.svelte";
  import { buildProblemPrompt } from "$lib/components/agent/prompts";

  function investigate(): void {
    void agentStore.quickAction(buildProblemPrompt({ context: k8sStore.currentContext }, problem));
  }

  interface Props {
    problem: Problem;
    diagnosis: Diagnosis | undefined;
    restartTarget: WorkloadRef | null;
    /** Logs of the problem's own resource (a Pod-kind problem). */
    onLogs: () => void;
    onRestart: () => void;
    onOpen: () => void;
    /** Optional overrides for the pod-level actions; the panel navigates itself when they are absent. */
    onPodOpen?: (pod: PodRef) => void;
    onPodLogs?: (pod: PodRef) => void;
    onYaml?: () => void;
  }

  let { problem, diagnosis, restartTarget, onLogs, onRestart, onOpen, onPodOpen, onPodLogs, onYaml }: Props = $props();
  let tone = $derived(problem.severity === "critical" ? "var(--status-failed)" : "var(--status-pending)");
  // The diagnosis carries cause/pod on the wire (electron/handlers/topology/diagnostics.ts);
  // DiagnosticResult in types/cluster.ts predates them, hence the narrowing here.
  let verdict = $derived<Partial<DiagnosisVerdict> | null>(diagnosis && diagnosis !== "loading" && !("error" in diagnosis) ? (diagnosis as Partial<DiagnosisVerdict>) : null);
  let actions = $derived(problemActions(problem, verdict));
  let causeLabel = $derived(CAUSE_LABEL[verdict?.cause ?? problem.cause ?? "unknown"] ?? "");
  let isPod = $derived(problem.kind === "Pod");
  /** The pod actions target another object than the problem itself (a workload's worst pod). */
  let podIsOther = $derived(actions.pod !== null && !(isPod && actions.pod.name === problem.name));
  let canRestart = $derived(actions.restart && restartTarget !== null && !!problem.namespace);

  async function openPod(pod: PodRef) {
    if (onPodOpen) return onPodOpen(pod);
    await openRelatedResourceTab("pods", pod.name, pod.namespace);
  }

  async function podLogs(pod: PodRef) {
    if (onPodLogs) return onPodLogs(pod);
    if (!podIsOther) return onLogs();
    const res = await k8sStore.getResource("Pod", pod.name, pod.namespace);
    if (!res) {
      toastStore.error("Pod not found", `${pod.namespace}/${pod.name} is gone`);
      return;
    }
    k8sStore.selectResource(res);
    uiStore.showLogs();
  }

  async function openYaml() {
    if (onYaml) return onYaml();
    const res = await k8sStore.getResource(problem.kind, problem.name, problem.namespace ?? undefined);
    if (!res) {
      toastStore.error("Resource not found", `${problem.kind}/${problem.name}`);
      return;
    }
    openResourceDetail(res, kindToResourceType(problem.kind));
    uiStore.showYamlEditor(problem.name);
  }
</script>

<div class="flex flex-col gap-5 p-4 text-[12px]" data-testid="problem-detail">
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <span class="truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">{problem.name}</span>
    </div>
    <span class="text-[11px] text-[var(--text-muted)]">{problem.kind}{problem.namespace ? ` · ${problem.namespace}` : ""}{problem.owner ? ` · owned by ${problem.owner}` : ""}</span>
    <div class="mt-3 flex flex-wrap gap-2" data-testid="problem-actions">
      {#if actions.pod}
        {@const pod = actions.pod}
        <Button size="sm" variant="accent" onclick={() => podLogs(pod)} data-testid="action-pod-logs"><ScrollText class="h-3.5 w-3.5" /> {podIsOther ? "View pod logs" : "Logs"}</Button>
        {#if podIsOther}
          <Button size="sm" variant="toolbar" onclick={() => openPod(pod)} data-testid="action-pod-open"><Box class="h-3.5 w-3.5" /> Open pod</Button>
        {/if}
      {/if}
      {#if canRestart && restartTarget}
        <Button size="sm" variant="toolbar" onclick={onRestart} data-testid="action-restart"><RefreshCw class="h-3.5 w-3.5" /> Restart {restartTarget.kind.toLowerCase()}</Button>
      {/if}
      {#if actions.yaml}
        <Button size="sm" variant="toolbar" onclick={openYaml} data-testid="action-yaml"><FileCode class="h-3.5 w-3.5" /> Open {problem.kind} YAML</Button>
      {/if}
      <Button size="sm" variant="toolbar" onclick={onOpen}><ExternalLink class="h-3.5 w-3.5" /> Open detail</Button>
      <Button size="sm" variant="toolbar" onclick={investigate} data-testid="action-agent"><Bot class="h-3.5 w-3.5" /> Investigate with agent</Button>
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <h3 class="text-[13px] font-medium text-[var(--text-primary)]">What is wrong</h3>
    <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
      <div class="flex items-center gap-2" style:color={tone}>
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style:background-color={tone}></span>
        <span class="min-w-0 truncate">{problem.reason}{problem.ready !== null && problem.desired !== null ? ` · ${problem.ready}/${problem.desired} ready` : ""}</span>
        {#if causeLabel}<span class="ml-auto shrink-0 text-[11px] text-[var(--text-muted)]" data-testid="problem-cause">{causeLabel}</span>{/if}
      </div>
      <div class="flex flex-col gap-1 pl-3.5 pt-1 text-[11px] text-[var(--text-muted)]">
        {#if problem.detail}<div class="text-[12px] leading-relaxed text-[var(--text-secondary)]">{problem.detail}</div>{/if}
        {#if podIsOther && actions.pod}<div class="font-mono">pod {actions.pod.name}{actions.pod.container ? ` · container ${actions.pod.container}` : ""}</div>{/if}
        {#if problem.restarts}<div>{problem.restarts} restarts</div>{/if}
        {#if problem.since}<div>since {formatTimestamp(problem.since)} ({formatAge(problem.since)})</div>{/if}
      </div>
    </div>
  </div>

  <div class="flex flex-col gap-2" data-testid="problem-diagnosis">
    <h3 class="text-[13px] font-medium text-[var(--text-primary)]">Diagnosis</h3>
    {#if !diagnosis || diagnosis === "loading"}
      <span class="text-[var(--text-muted)]">Checking…</span>
    {:else if "error" in diagnosis}
      <span class="text-[var(--text-muted)]">Not available: {diagnosis.error}</span>
    {:else if diagnosis.issues.length === 0}
      <span class="text-[var(--text-muted)]">The diagnostics found nothing beyond the status above.</span>
    {:else}
      <ul class="flex flex-col gap-2">
        {#each diagnosis.issues as issue, i (i)}
          <li class="flex flex-col gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
            <div class="flex items-center gap-2">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full" style:background-color={issue.severity === "critical" ? "var(--status-failed)" : issue.severity === "warning" ? "var(--status-pending)" : "var(--status-succeeded)"} title={issue.severity}></span>
              <span class="font-medium text-[var(--text-primary)]">{issue.title}</span>
            </div>
            <div class="leading-relaxed text-[var(--text-secondary)]">{issue.detail}</div>
            {#if issue.suggestion}<div class="flex items-center gap-2 text-[var(--text-primary)]"><ArrowRight class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />{issue.suggestion}</div>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
