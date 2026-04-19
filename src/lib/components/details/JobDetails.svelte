<script lang="ts">
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import InlineStat from "./InlineStat.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
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

  let completions = $derived((spec.completions as number) ?? 1);
  let parallelism = $derived((spec.parallelism as number) ?? 1);
  let backoffLimit = $derived((spec.backoffLimit as number) ?? 6);

  let active = $derived((status.active as number) ?? 0);
  let succeeded = $derived((status.succeeded as number) ?? 0);
  let failed = $derived((status.failed as number) ?? 0);

  let startTime = $derived((status.startTime as string) ?? null);
  let completionTime = $derived((status.completionTime as string) ?? null);

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

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Start Time" value={startTime ? formatTimestamp(startTime) : "-"} />
    <InfoRow label="Completion" value={completionTime ? formatTimestamp(completionTime) : "-"} />
    <InfoRow label="Duration" value={formatDuration(startTime, completionTime)} />
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />
    {#if spec.ttlSecondsAfterFinished !== undefined}<InfoRow label="TTL After Finished" value={`${spec.ttlSecondsAfterFinished}s`} />{/if}
    {#if spec.suspend}<InfoRow label="Suspended" value="Yes" valueColor="var(--status-pending)" />{/if}
    {#if spec.completionMode}<InfoRow label="Completion Mode" value={spec.completionMode as string} />{/if}

    <!-- Configuration + Pod Status -->
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex items-center gap-4">
        <InlineStat label="Completions" value={completions} />
        <span class="text-[var(--border-hover)]">·</span>
        <InlineStat label="Parallelism" value={parallelism} />
        <span class="text-[var(--border-hover)]">·</span>
        <InlineStat label="Backoff" value={backoffLimit} />
      </div>
    </div>

    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex items-center gap-4">
        <InlineStat label="Active" value={active} color={active > 0 ? "var(--status-pending)" : undefined} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Succeeded" value={succeeded} color={succeeded > 0 ? "var(--status-running)" : undefined} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Failed" value={failed} color={failed > 0 ? "var(--status-failed)" : undefined} />
      </div>
    </div>

    <CollapsibleConditions {conditions} />
  </div>

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="jobs" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
