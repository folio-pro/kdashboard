<script lang="ts">
  import { Copy } from "lucide-svelte";
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

  let desiredNumberScheduled = $derived((status.desiredNumberScheduled as number) ?? 0);
  let currentNumberScheduled = $derived((status.currentNumberScheduled as number) ?? 0);
  let numberReady = $derived((status.numberReady as number) ?? 0);
  let numberAvailable = $derived((status.numberAvailable as number) ?? 0);
  let updatedNumberScheduled = $derived((status.updatedNumberScheduled as number) ?? 0);
  let numberMisscheduled = $derived((status.numberMisscheduled as number) ?? 0);

  let updateStrategy = $derived(
    (spec.updateStrategy as { type?: string; rollingUpdate?: { maxUnavailable?: string | number } }) ?? {}
  );

  let conditions = $derived(
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="DaemonSet Spec" icon={Copy}>
    <KvGrid>
      <KvField label="Desired" value={desiredNumberScheduled} />
      <KvField label="Current" value={currentNumberScheduled} />
      <KvField label="Ready">
        <span class="font-mono text-[13px] {numberReady === desiredNumberScheduled ? 'text-[var(--text-primary)]' : 'text-[var(--status-pending)]'}">{numberReady}</span>
      </KvField>
      <KvField label="Available" value={numberAvailable} />
      <KvField label="Updated" value={updatedNumberScheduled} />
      {#if numberMisscheduled > 0}
        <KvField label="Misscheduled">
          <span class="font-mono text-[13px] text-[var(--status-failed)]">{numberMisscheduled}</span>
        </KvField>
      {/if}
      <KvField label="Update Strategy" value={updateStrategy.type ?? "RollingUpdate"} mono={false} />
      {#if updateStrategy.rollingUpdate?.maxUnavailable !== undefined}
        <KvField label="Max Unavailable" value={String(updateStrategy.rollingUpdate.maxUnavailable)} />
      {/if}
    </KvGrid>
  </DetailSection>

  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} />
  {/if}

  <StrategyCard {spec} kind="DaemonSet" />

  <RelatedResourcesCard {resource} resourceType="daemonsets" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
