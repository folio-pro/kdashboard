<script lang="ts">
  import { Play } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import { formatTimestamp } from "$lib/utils/age";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});

  let completions = $derived((spec.completions as number) ?? 1);
  let parallelism = $derived((spec.parallelism as number) ?? 1);
  let backoffLimit = $derived((spec.backoffLimit as number) ?? 6);

  let active = $derived((status.active as number) ?? 0);
  let succeeded = $derived((status.succeeded as number) ?? 0);
  let failed = $derived((status.failed as number) ?? 0);

  let startTime = $derived((status.startTime as string) ?? null);
  let completionTime = $derived((status.completionTime as string) ?? null);

  let conditions = $derived(
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  function formatDuration(start: string | null, end: string | null): string {
    if (!start) return "-";
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const diffMs = endDate.getTime() - startDate.getTime();
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="Job Spec" icon={Play}>
    <KvGrid>
      <KvField label="Active">
        <span class="font-mono text-[13px] {active > 0 ? 'text-[var(--status-pending)]' : 'text-[var(--text-primary)]'}">{active}</span>
      </KvField>
      <KvField label="Succeeded">
        <span class="font-mono text-[13px] {succeeded > 0 ? 'text-[var(--status-running)]' : 'text-[var(--text-primary)]'}">{succeeded}</span>
      </KvField>
      <KvField label="Failed">
        <span class="font-mono text-[13px] {failed > 0 ? 'text-[var(--status-failed)]' : 'text-[var(--text-primary)]'}">{failed}</span>
      </KvField>
      <KvField label="Completions" value={completions} />
      <KvField label="Parallelism" value={parallelism} />
      <KvField label="Backoff Limit" value={backoffLimit} />
      <KvField label="Start Time" value={startTime ? formatTimestamp(startTime) : "-"} mono={false} />
      <KvField label="Completion" value={completionTime ? formatTimestamp(completionTime) : "-"} mono={false} />
      <KvField label="Duration" value={formatDuration(startTime, completionTime)} />
      {#if spec.ttlSecondsAfterFinished !== undefined}
        <KvField label="TTL After Finished" value={`${spec.ttlSecondsAfterFinished}s`} />
      {/if}
      {#if spec.suspend}
        <KvField label="Suspended">
          <span class="font-mono text-[13px] text-[var(--status-pending)]">Yes</span>
        </KvField>
      {/if}
      {#if spec.completionMode}
        <KvField label="Completion Mode" value={spec.completionMode as string} mono={false} />
      {/if}
    </KvGrid>
  </DetailSection>

  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} />
  {/if}

  <RelatedResourcesCard {resource} resourceType="jobs" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
