<script lang="ts">
  import { Database, HardDrive } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
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

  let updateStrategy = $derived((spec.updateStrategy as { type?: string }) ?? {});
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
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="StatefulSet Spec" icon={Database}>
    <KvGrid>
      <KvField label="Ready">
        <span class="font-mono text-[13px] {readyReplicas === replicas ? 'text-[var(--text-primary)]' : 'text-[var(--status-pending)]'}">{readyReplicas}/{replicas}</span>
      </KvField>
      <KvField label="Current" value={currentReplicas} />
      <KvField label="Updated" value={updatedReplicas} />
      <KvField label="Service Name" value={serviceName} />
      <KvField label="Update Strategy" value={updateStrategy.type ?? "RollingUpdate"} mono={false} />
      <KvField label="Pod Management" value={podManagementPolicy} mono={false} />
    </KvGrid>
  </DetailSection>

  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} />
  {/if}

  {#if volumeClaimTemplates.length > 0}
    <DetailSection title="Volume Claim Templates" icon={HardDrive}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{volumeClaimTemplates.length}</span>
      {/snippet}
      <div class="flex flex-col gap-2">
        {#each volumeClaimTemplates as vct}
          <div class="flex items-center justify-between rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="text-[13px] font-medium text-[var(--text-primary)]">{vct.metadata?.name ?? "unnamed"}</span>
              <span class="font-mono text-[11px] text-[var(--text-muted)]">{vct.spec?.storageClassName ?? "default"} · {vct.spec?.accessModes?.join(", ") ?? "-"}</span>
            </div>
            <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">{vct.spec?.resources?.requests?.storage ?? "-"}</span>
          </div>
        {/each}
      </div>
    </DetailSection>
  {/if}

  <StrategyCard {spec} kind="StatefulSet" />

  <RelatedResourcesCard {resource} resourceType="statefulsets" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
