<script lang="ts">
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import InlineStat from "./InlineStat.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import EventsCard from "./EventsCard.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import StrategyCard from "./StrategyCard.svelte";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});

  let desiredNumberScheduled = $derived((status.desiredNumberScheduled as number) ?? 0);
  let currentNumberScheduled = $derived((status.currentNumberScheduled as number) ?? 0);
  let numberReady = $derived((status.numberReady as number) ?? 0);
  let numberAvailable = $derived((status.numberAvailable as number) ?? 0);
  let updatedNumberScheduled = $derived((status.updatedNumberScheduled as number) ?? 0);
  let numberMisscheduled = $derived((status.numberMisscheduled as number) ?? 0);

  let updateStrategy = $derived(
    (spec.updateStrategy as { type?: string; rollingUpdate?: { maxUnavailable?: string | number } }) ?? {}
  );

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
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Update Strategy" value={updateStrategy.type ?? "RollingUpdate"} />
    {#if updateStrategy.rollingUpdate?.maxUnavailable !== undefined}
      <InfoRow label="Max Unavailable" value={String(updateStrategy.rollingUpdate.maxUnavailable)} />
    {/if}
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />

    <!-- Status -->
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex flex-wrap items-center gap-4">
        <InlineStat label="Desired" value={desiredNumberScheduled} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Current" value={currentNumberScheduled} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Ready" value={numberReady} color={numberReady === desiredNumberScheduled ? "var(--status-running)" : "var(--status-pending)"} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Available" value={numberAvailable} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Updated" value={updatedNumberScheduled} />
        {#if numberMisscheduled > 0}
          <span class="text-[var(--border-hover)]">/</span>
          <InlineStat label="Misscheduled" value={numberMisscheduled} color="var(--status-failed)" />
        {/if}
      </div>
    </div>

    <CollapsibleConditions {conditions} />
  </div>

  <!-- Strategy -->
  <StrategyCard {spec} kind="DaemonSet" />

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="daemonsets" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels labels={labels} selector={selector} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
