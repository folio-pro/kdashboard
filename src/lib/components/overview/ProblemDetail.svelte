<script lang="ts">
  import { Badge, Button } from "$lib/components/ui";
  import { ScrollText, ExternalLink, RefreshCw, Stethoscope } from "lucide-svelte";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import { cn } from "$lib/utils";
  import type { Problem } from "$lib/types";
  import type { WorkloadRef } from "$lib/utils/pod-status";
  import type { Diagnosis } from "$lib/stores/overview.svelte";

  interface Props {
    problem: Problem;
    diagnosis: Diagnosis | undefined;
    restartTarget: WorkloadRef | null;
    onLogs: () => void;
    onRestart: () => void;
    onOpen: () => void;
  }

  let { problem, diagnosis, restartTarget, onLogs, onRestart, onOpen }: Props = $props();
  let critical = $derived(problem.severity === "critical");
</script>

<div class="flex flex-col gap-4 p-4 text-[12px]" data-testid="problem-detail">
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <span class={cn("h-2 w-2 rounded-full", critical ? "bg-[var(--status-failed)]" : "bg-[var(--status-pending)]")}></span>
      <span class="truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">{problem.name}</span>
    </div>
    <span class="text-[11px] text-[var(--text-muted)]">{problem.kind}{problem.namespace ? ` · ${problem.namespace}` : ""}{problem.owner ? ` · owned by ${problem.owner}` : ""}</span>
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#if problem.kind === "Pod"}
        <Button size="sm" variant="accent" onclick={onLogs}><ScrollText class="h-3 w-3" /> Logs</Button>
      {/if}
      {#if restartTarget && problem.namespace}
        <Button size="sm" variant="outline" onclick={onRestart}><RefreshCw class="h-3 w-3" /> Restart {restartTarget.kind.toLowerCase()}</Button>
      {/if}
      <Button size="sm" variant="outline" onclick={onOpen}><ExternalLink class="h-3 w-3" /> Open detail</Button>
    </div>
  </div>

  <div class="flex flex-col gap-1.5">
    <span class="text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">What is wrong</span>
    <div class={cn("rounded-md border px-3 py-2", critical ? "border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10" : "border-[var(--status-pending)]/30 bg-[var(--status-pending)]/10")}>
      <div class="font-medium text-[var(--text-primary)]">{problem.reason}{problem.ready !== null && problem.desired !== null ? ` · ${problem.ready}/${problem.desired} ready` : ""}</div>
      {#if problem.detail}<div class="mt-1 leading-relaxed text-[var(--text-secondary)]">{problem.detail}</div>{/if}
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
