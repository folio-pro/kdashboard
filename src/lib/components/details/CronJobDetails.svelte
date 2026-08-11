<script lang="ts">
  import { Clock } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import { formatTimestamp } from "$lib/utils/age";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});

  let schedule = $derived((spec.schedule as string) ?? "-");
  let concurrencyPolicy = $derived((spec.concurrencyPolicy as string) ?? "Allow");
  let suspend = $derived((spec.suspend as boolean) ?? false);
  let successfulJobsHistoryLimit = $derived((spec.successfulJobsHistoryLimit as number) ?? 3);
  let failedJobsHistoryLimit = $derived((spec.failedJobsHistoryLimit as number) ?? 1);
  let startingDeadlineSeconds = $derived((spec.startingDeadlineSeconds as number | null) ?? null);

  let lastScheduleTime = $derived((status.lastScheduleTime as string) ?? null);
  let lastSuccessfulTime = $derived((status.lastSuccessfulTime as string) ?? null);
  let activeJobs = $derived(
    (status.active as Array<{ name?: string; namespace?: string }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="CronJob Spec" icon={Clock}>
    {#snippet actions()}
      {#if suspend}
        <span class="inline-flex items-center rounded border border-[var(--status-pending)]/30 bg-[var(--status-pending)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-pending)]">Suspended</span>
      {/if}
    {/snippet}
    <KvGrid>
      <KvField label="Schedule" value={schedule} />
      <KvField label="Concurrency" value={concurrencyPolicy} mono={false} />
      <KvField label="Active">
        <span class="font-mono text-[13px] {activeJobs.length > 0 ? 'text-[var(--status-pending)]' : 'text-[var(--text-primary)]'}">{activeJobs.length}</span>
      </KvField>
      <KvField label="Last Schedule" value={lastScheduleTime ? formatTimestamp(lastScheduleTime) : "-"} mono={false} />
      <KvField label="Last Success" value={lastSuccessfulTime ? formatTimestamp(lastSuccessfulTime) : "-"} mono={false} />
      {#if startingDeadlineSeconds !== null}
        <KvField label="Start Deadline" value={`${startingDeadlineSeconds}s`} />
      {/if}
      {#if spec.timeZone}
        <KvField label="Time Zone" value={spec.timeZone as string} mono={false} />
      {/if}
      <KvField label="Keep Success" value={successfulJobsHistoryLimit} />
      <KvField label="Keep Failed" value={failedJobsHistoryLimit} />
    </KvGrid>
  </DetailSection>

  {#if activeJobs.length > 0}
    <DetailSection title="Active Jobs" icon={Clock}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{activeJobs.length}</span>
      {/snippet}
      <div class="flex flex-col gap-1.5">
        {#each activeJobs as job}
          <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{job.name ?? "unknown"}</span>
        {/each}
      </div>
    </DetailSection>
  {/if}

  <RelatedResourcesCard {resource} resourceType="cronjobs" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
