<script lang="ts">
  import type { Resource } from "$lib/types";
  import { invoke } from "$lib/ipc/core";
  import { Box } from "lucide-svelte";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvGrid from "./KvGrid.svelte";
  import KvField from "./KvField.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import StrategyCard from "./StrategyCard.svelte";
  import RevisionHistoryCard from "./RevisionHistoryCard.svelte";
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let image = $derived(
    (((spec.template as any)?.spec?.containers?.[0]?.image) as string) ?? "—"
  );
  let conditionLabel = $derived(
    conditions.find((c) => c.type === "Available")?.status === "True"
      ? "Available"
      : conditions.find((c) => c.type === "Progressing")?.status === "True"
        ? "Progressing"
        : "Unavailable"
  );

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

<div class="select-text">
  <MetadataSection {resource} />

  <!-- Deployment Spec -->
  <DetailSection title="Deployment Spec" icon={Box}>
    <KvGrid>
      <KvField label="Ready">
        <span class="font-mono text-[13px] {readyReplicas === replicas ? 'text-[var(--text-primary)]' : 'text-[var(--status-pending)]'}">{readyReplicas}/{replicas}</span>
      </KvField>
      <KvField label="Up-to-date" value={updatedReplicas} />
      <KvField label="Available" value={availableReplicas} />
      <KvField label="Strategy" value={strategy} mono={false} />
      <KvField label="Conditions">
        <StatusBadge status={conditionLabel} />
      </KvField>
      {#if selectorString}
        <KvField label="Selector" value={selectorString} />
      {/if}
      <KvField label="Image" value={image} />
      {#if spec.paused}
        <KvField label="Paused">
          <span class="font-mono text-[13px] text-[var(--status-pending)]">true</span>
        </KvField>
      {/if}
    </KvGrid>
  </DetailSection>

  <LabelsSection {labels} />

  <!-- Conditions -->
  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} />
  {/if}

  <!-- Pods -->
  <DetailSection title="Pods" icon={Box}>
    {#snippet actions()}
      <span class="font-mono text-[11px] text-[var(--text-dimmed)]">{podsLoading ? "…" : pods.length}</span>
    {/snippet}
    {#if pods.length > 0}
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-[var(--border-color)]">
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Name</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Status</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Ready</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Restarts</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Age</th>
          </tr>
        </thead>
        <tbody>
          {#each pods as pod}
            <tr
              class="cursor-pointer border-b border-[var(--border-color)] last:border-b-0 transition-colors hover:bg-[var(--table-row-hover)]"
              onclick={() => handlePodClick(pod)}
            >
              <td class="max-w-[200px] truncate px-3 py-2.5 text-[12px] font-medium text-[var(--text-primary)]" title={pod.metadata.name}>{pod.metadata.name}</td>
              <td class="px-3 py-2.5"><StatusBadge status={getPodPhase(pod)} /></td>
              <td class="px-3 py-2.5 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">{getPodReadyCount(pod)}</td>
              <td class="px-3 py-2.5 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">{getPodRestarts(pod)}</td>
              <td class="px-3 py-2.5 font-mono text-[12px] text-[var(--text-muted)]">{formatAge(pod.metadata.creation_timestamp)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if !podsLoading}
      <p class="text-xs text-[var(--text-muted)]">No pods found</p>
    {/if}
  </DetailSection>

  <StrategyCard {spec} kind="Deployment" />
  <RevisionHistoryCard {resource} />
  <RelatedResourcesCard {resource} resourceType="deployments" />
  <SmartAnnotationsCard annotations={annotations} />
</div>
