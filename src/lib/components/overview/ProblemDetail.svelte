<script lang="ts">
  import { Badge, Button } from "$lib/components/ui";
  import { ScrollText, ExternalLink, RefreshCw, Stethoscope, FileCode, Box, Bot } from "lucide-svelte";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import { cn } from "$lib/utils";
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
  let critical = $derived(problem.severity === "critical");
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

<div class="flex flex-col gap-4 p-4 text-[12px]" data-testid="problem-detail">
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <span class={cn("h-2 w-2 rounded-full", critical ? "bg-[var(--status-failed)]" : "bg-[var(--status-pending)]")}></span>
      <span class="truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">{problem.name}</span>
    </div>
    <span class="text-[11px] text-[var(--text-muted)]">{problem.kind}{problem.namespace ? ` · ${problem.namespace}` : ""}{problem.owner ? ` · owned by ${problem.owner}` : ""}</span>
    <div class="mt-2 flex flex-wrap gap-1.5" data-testid="problem-actions">
      {#if actions.pod}
        {@const pod = actions.pod}
        <Button size="sm" variant="accent" onclick={() => podLogs(pod)} data-testid="action-pod-logs"><ScrollText class="h-3 w-3" /> {podIsOther ? "View pod logs" : "Logs"}</Button>
        {#if podIsOther}
          <Button size="sm" variant="outline" onclick={() => openPod(pod)} data-testid="action-pod-open"><Box class="h-3 w-3" /> Open pod</Button>
        {/if}
      {/if}
      {#if canRestart && restartTarget}
        <Button size="sm" variant="outline" onclick={onRestart} data-testid="action-restart"><RefreshCw class="h-3 w-3" /> Restart {restartTarget.kind.toLowerCase()}</Button>
      {/if}
      {#if actions.yaml}
        <Button size="sm" variant="outline" onclick={openYaml} data-testid="action-yaml"><FileCode class="h-3 w-3" /> Open {problem.kind} YAML</Button>
      {/if}
      <Button size="sm" variant="outline" onclick={onOpen}><ExternalLink class="h-3 w-3" /> Open detail</Button>
      <Button size="sm" variant="outline" onclick={investigate} data-testid="action-agent"><Bot class="h-3 w-3" /> Investigate with agent</Button>
    </div>
  </div>

  <div class="flex flex-col gap-1.5">
    <span class="text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">What is wrong</span>
    <div class={cn("rounded-md border px-3 py-2", critical ? "border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10" : "border-[var(--status-pending)]/30 bg-[var(--status-pending)]/10")}>
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-[var(--text-primary)]">{problem.reason}{problem.ready !== null && problem.desired !== null ? ` · ${problem.ready}/${problem.desired} ready` : ""}</span>
        {#if causeLabel}<Badge appearance="surface" size="xs" data-testid="problem-cause">{causeLabel}</Badge>{/if}
      </div>
      {#if problem.detail}<div class="mt-1 leading-relaxed text-[var(--text-secondary)]">{problem.detail}</div>{/if}
      {#if podIsOther && actions.pod}<div class="mt-1 font-mono text-[11px] text-[var(--text-muted)]">pod {actions.pod.name}{actions.pod.container ? ` · container ${actions.pod.container}` : ""}</div>{/if}
      {#if problem.restarts}<div class="mt-1 text-[11px] text-[var(--text-muted)]">{problem.restarts} restarts</div>{/if}
      {#if problem.since}<div class="mt-1 text-[11px] text-[var(--text-muted)]">since {formatTimestamp(problem.since)} ({formatAge(problem.since)})</div>{/if}
    </div>
  </div>

  <div class="flex flex-col gap-1.5" data-testid="problem-diagnosis">
    <span class="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]"><Stethoscope class="h-3 w-3" /> Diagnosis</span>
    {#if !diagnosis || diagnosis === "loading"}
      <span class="text-[var(--text-muted)]">Checking…</span>
    {:else if "error" in diagnosis}
      <span class="text-[var(--text-muted)]">Not available: {diagnosis.error}</span>
    {:else if diagnosis.issues.length === 0}
      <span class="text-[var(--text-muted)]">The diagnostics found nothing beyond the status above.</span>
    {:else}
      <ul class="flex flex-col gap-2">
        {#each diagnosis.issues as issue, i (i)}
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
