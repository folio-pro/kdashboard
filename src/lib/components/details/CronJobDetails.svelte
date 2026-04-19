<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import InlineStat from "./InlineStat.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import EventsCard from "./EventsCard.svelte";
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

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
      {#if suspend}
        <Badge variant="destructive">Suspended</Badge>
      {/if}
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Schedule" value={schedule} />
    <InfoRow label="Concurrency" value={concurrencyPolicy} />
    {#if startingDeadlineSeconds !== null}
      <InfoRow label="Start Deadline" value={`${startingDeadlineSeconds}s`} />
    {/if}
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />
    {#if spec.timeZone}<InfoRow label="Time Zone" value={spec.timeZone as string} />{/if}
    {#if spec.failedJobsHistoryLimit !== undefined}<InfoRow label="Failed History Limit" value={String(spec.failedJobsHistoryLimit)} />{/if}
    {#if spec.successfulJobsHistoryLimit !== undefined}<InfoRow label="Success History Limit" value={String(spec.successfulJobsHistoryLimit)} />{/if}

    <!-- History + status -->
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex items-center gap-4">
        <InlineStat label="Keep Success" value={successfulJobsHistoryLimit} color="var(--status-running)" />
        <span class="text-[var(--border-hover)]">·</span>
        <InlineStat label="Keep Failed" value={failedJobsHistoryLimit} color="var(--status-failed)" />
        <span class="text-[var(--border-hover)]">·</span>
        <InlineStat label="Active" value={activeJobs.length} color={activeJobs.length > 0 ? "var(--status-pending)" : undefined} />
      </div>
    </div>

    <InfoRow label="Last Schedule" value={lastScheduleTime ? formatTimestamp(lastScheduleTime) : "-"} />
    <InfoRow label="Last Success" value={lastSuccessfulTime ? formatTimestamp(lastSuccessfulTime) : "-"} />
  </div>

  {#if activeJobs.length > 0}
    <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div class="flex items-center justify-between px-5 py-4">
        <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Active Jobs</h3>
        <span class="text-[11px] text-[var(--text-muted)]">{activeJobs.length} running</span>
      </div>
      {#each activeJobs as job}
        <div class="flex items-center gap-3.5 border-t border-[var(--border-hover)] px-5 py-3.5">
          <span class="truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">{job.name ?? "unknown"}</span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="cronjobs" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
