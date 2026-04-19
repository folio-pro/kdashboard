<script lang="ts">
  import type { Resource } from "$lib/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
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

  let replicas = $derived((spec.replicas as number) ?? 0);
  let readyReplicas = $derived((status.readyReplicas as number) ?? 0);
  let currentReplicas = $derived((status.currentReplicas as number) ?? 0);
  let updatedReplicas = $derived((status.updatedReplicas as number) ?? 0);

  let updateStrategy = $derived(
    (spec.updateStrategy as { type?: string }) ?? {}
  );
  let serviceName = $derived((spec.serviceName as string) ?? "-");
  let podManagementPolicy = $derived((spec.podManagementPolicy as string) ?? "OrderedReady");

  let volumeClaimTemplates = $derived(
    (spec.volumeClaimTemplates as Array<{
      metadata?: { name?: string };
      spec?: {
        storageClassName?: string;
        accessModes?: string[];
        resources?: { requests?: { storage?: string } };
      };
    }>) ?? []
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
    <InfoRow label="Service Name" value={serviceName} />
    <InfoRow label="Update Strategy" value={updateStrategy.type ?? "RollingUpdate"} />
    <InfoRow label="Pod Management" value={podManagementPolicy} />
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />

    <!-- Replicas -->
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex items-center gap-4">
        <InlineStat label="Desired" value={replicas} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Ready" value={readyReplicas} color={readyReplicas === replicas ? "var(--status-running)" : "var(--status-pending)"} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Current" value={currentReplicas} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Updated" value={updatedReplicas} />
      </div>
    </div>

    <CollapsibleConditions {conditions} />
  </div>

  <!-- Volume Claim Templates -->
  {#if volumeClaimTemplates.length > 0}
    <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div class="flex items-center justify-between px-5 py-4">
        <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Volume Claim Templates</h3>
        <span class="text-[11px] text-[var(--text-muted)]">{volumeClaimTemplates.length} templates</span>
      </div>
      {#each volumeClaimTemplates as vct}
        <div class="flex items-center justify-between border-t border-[var(--border-hover)] px-5 py-3.5">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-[13px] font-semibold text-[var(--text-primary)]">{vct.metadata?.name ?? "unnamed"}</span>
            <span class="text-xs text-[var(--text-muted)]">
              {vct.spec?.storageClassName ?? "default"} · {vct.spec?.accessModes?.join(", ") ?? "-"}
            </span>
          </div>
          <span class="font-mono text-sm font-bold text-[var(--text-primary)]">{vct.spec?.resources?.requests?.storage ?? "-"}</span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Update Strategy -->
  <StrategyCard {spec} kind="StatefulSet" />

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="statefulsets" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
