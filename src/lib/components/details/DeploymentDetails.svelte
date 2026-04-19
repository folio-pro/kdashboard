<script lang="ts">
  import type { Resource } from "$lib/types";
  import { invoke } from "@tauri-apps/api/core";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import InfoRow from "./InfoRow.svelte";
  import InlineStat from "./InlineStat.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import IncidentTimeline from "./IncidentTimeline.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import StrategyCard from "./StrategyCard.svelte";
  import { formatAge } from "$lib/utils/age";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { openResourceDetail } from "$lib/actions/navigation";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});

  let replicas = $derived((spec.replicas as number) ?? 0);
  let readyReplicas = $derived((status.readyReplicas as number) ?? 0);
  let availableReplicas = $derived((status.availableReplicas as number) ?? 0);
  let updatedReplicas = $derived((status.updatedReplicas as number) ?? 0);

  let strategy = $derived((spec.strategy as { type?: string })?.type ?? "RollingUpdate");
  let selector = $derived(
    (spec.selector as { matchLabels?: Record<string, string> })?.matchLabels ?? {}
  );
  let conditions = $derived(
    (status.conditions as Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }>) ?? []
  );
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  // Pods belonging to this deployment
  let pods = $state<Resource[]>([]);
  let podsLoading = $state(false);

  let selectorString = $derived(
    Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",")
  );

  function getPodPhase(pod: Resource): string {
    return (pod.status?.phase as string) ?? "Unknown";
  }

  function getPodReadyCount(pod: Resource): string {
    const containerStatuses = (pod.status?.containerStatuses as Array<{ ready: boolean }>) ?? [];
    const total = containerStatuses.length;
    const ready = containerStatuses.filter((c) => c.ready).length;
    return `${ready}/${total}`;
  }

  function getPodRestarts(pod: Resource): number {
    const containerStatuses = (pod.status?.containerStatuses as Array<{ restartCount: number }>) ?? [];
    return containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  }

  function handlePodClick(pod: Resource) {
    openResourceDetail(pod, "pods");
  }

  $effect(() => {
    const sel = selectorString;
    let cancelled = false;

    if (sel) {
      podsLoading = true;
      invoke<{ items: Resource[] }>("list_pods_by_selector", {
        namespace: resource.metadata.namespace ?? "",
        selector: sel,
      }).then((result) => {
        if (!cancelled) pods = result.items;
      }).catch(() => {
        if (!cancelled) pods = [];
      }).finally(() => {
        if (!cancelled) podsLoading = false;
      });
    }

    return () => { cancelled = true; };
  });
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Strategy" value={strategy} />
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />

    <!-- Replicas -->
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex items-center gap-4">
        <InlineStat label="Desired" value={replicas} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Ready" value={readyReplicas} color={readyReplicas === replicas ? "var(--status-running)" : "var(--status-pending)"} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Available" value={availableReplicas} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Updated" value={updatedReplicas} />
      </div>
    </div>

    <CollapsibleConditions {conditions} />
    {#if spec.minReadySeconds}
      <InfoRow label="Min Ready Seconds" value={String(spec.minReadySeconds)} />
    {/if}
    {#if spec.progressDeadlineSeconds}
      <InfoRow label="Progress Deadline" value={`${spec.progressDeadlineSeconds}s`} />
    {/if}
    {#if spec.paused}
      <InfoRow label="Paused" value="Deployment is paused" valueColor="var(--status-pending)" />
    {/if}
  </div>

  <!-- Pods Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Pods</h3>
      <span class="text-[11px] text-[var(--text-muted)]">
        {#if podsLoading}
          loading…
        {:else}
          {pods.length} pods
        {/if}
      </span>
    </div>
    {#if pods.length > 0}
      <div class="border-t border-[var(--border-hover)]">
        <table class="w-full">
          <thead>
            <tr class="border-b border-[var(--border-hover)]">
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Name</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Status</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Ready</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Restarts</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Age</th>
            </tr>
          </thead>
          <tbody>
            {#each pods as pod}
              <tr
                class="cursor-pointer border-b border-[var(--border-hover)] last:border-b-0 transition-colors hover:bg-[var(--bg-tertiary)]"
                onclick={() => handlePodClick(pod)}
              >
                <td class="max-w-[200px] truncate px-4 py-2.5 text-[12px] font-medium text-[var(--text-primary)]" title={pod.metadata.name}>
                  {pod.metadata.name}
                </td>
                <td class="px-4 py-2.5">
                  <StatusBadge status={getPodPhase(pod)} />
                </td>
                <td class="px-4 py-2.5 text-[12px] text-[var(--text-secondary)]">
                  {getPodReadyCount(pod)}
                </td>
                <td class="px-4 py-2.5 text-[12px] text-[var(--text-secondary)]">
                  {getPodRestarts(pod)}
                </td>
                <td class="px-4 py-2.5 text-[12px] text-[var(--text-muted)]">
                  {formatAge(pod.metadata.creation_timestamp)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if !podsLoading}
      <div class="border-t border-[var(--border-hover)] px-5 py-4">
        <span class="text-xs text-[var(--text-muted)]">No pods found</span>
      </div>
    {/if}
  </div>

  <!-- Strategy & Rollout -->
  <StrategyCard {spec} kind="Deployment" />

  <!-- Activity Timeline -->
  <IncidentTimeline {resource} />

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="deployments" />

  <!-- Labels & Annotations -->
  <CollapsibleLabels labels={labels} selector={selector} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
