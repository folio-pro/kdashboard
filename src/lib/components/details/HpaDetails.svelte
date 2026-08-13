<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import { TrendingUp } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import ScalingBehaviorCard from "./ScalingBehaviorCard.svelte";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let spec = $derived(resource.spec ?? {});
  let status = $derived(resource.status ?? {});

  let scaleTargetRef = $derived(
    (spec.scaleTargetRef as { kind?: string; name?: string; apiVersion?: string }) ?? {}
  );
  let minReplicas = $derived((spec.minReplicas as number) ?? 1);
  let maxReplicas = $derived((spec.maxReplicas as number) ?? 0);
  let currentReplicas = $derived((status.currentReplicas as number) ?? 0);
  let desiredReplicas = $derived((status.desiredReplicas as number) ?? 0);

  let metrics = $derived(
    (spec.metrics as Array<{
      type?: string;
      resource?: {
        name?: string;
        target?: { type?: string; averageUtilization?: number; averageValue?: string; value?: string };
      };
      pods?: { metric?: { name?: string }; target?: { type?: string; averageValue?: string } };
      object?: {
        metric?: { name?: string };
        describedObject?: { kind?: string; name?: string };
        target?: { type?: string; value?: string; averageValue?: string };
      };
    }>) ?? []
  );

  let currentMetrics = $derived(
    (status.currentMetrics as Array<{
      type?: string;
      resource?: { name?: string; current?: { averageUtilization?: number; averageValue?: string } };
    }>) ?? []
  );

  let conditions = $derived(
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  function getCurrentForMetric(metricName: string): string {
    const found = currentMetrics.find((m) => m.resource?.name === metricName);
    if (!found?.resource?.current) return "-";
    if (found.resource.current.averageUtilization !== undefined) {
      return `${found.resource.current.averageUtilization}%`;
    }
    return found.resource.current.averageValue ?? "-";
  }

  function getTargetForMetric(metric: typeof metrics[0]): string {
    if (metric.resource?.target?.averageUtilization !== undefined) {
      return `${metric.resource.target.averageUtilization}%`;
    }
    if (metric.resource?.target?.averageValue) return metric.resource.target.averageValue;
    if (metric.resource?.target?.value) return metric.resource.target.value;
    return "-";
  }

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="HPA Spec" icon={TrendingUp}>
    <KvGrid>
      <KvField label="Target">
        <span class="font-mono text-[13px] text-[var(--text-primary)]">{scaleTargetRef.kind ?? "Unknown"}/{scaleTargetRef.name ?? "-"}</span>
      </KvField>
      <KvField label="Min Replicas" value={minReplicas} />
      <KvField label="Max Replicas" value={maxReplicas} />
      <KvField label="Current" value={currentReplicas} />
      <KvField label="Desired">
        <span class="font-mono text-[13px] {desiredReplicas !== currentReplicas ? 'text-[var(--status-pending)]' : 'text-[var(--text-primary)]'}">{desiredReplicas}</span>
      </KvField>
    </KvGrid>
  </DetailSection>

  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} />
  {/if}

  {#if metrics.length > 0}
    <DetailSection title="Metrics" icon={TrendingUp}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{metrics.length}</span>
      {/snippet}
      <div class="flex flex-col gap-2">
        {#each metrics as metric}
          {@const metricName = metric.resource?.name ?? metric.pods?.metric?.name ?? metric.object?.metric?.name ?? "unknown"}
          {@const current = metric.type === "Resource" && metric.resource?.name ? getCurrentForMetric(metric.resource.name) : "-"}
          {@const target = getTargetForMetric(metric)}
          <div class="flex items-center justify-between rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <div class="flex items-center gap-2.5">
              <span class="text-[13px] font-medium text-[var(--text-primary)]">{metricName}</span>
              <Badge appearance="surface" bordered mono>{metric.type ?? "Resource"}</Badge>
            </div>
            <div class="flex items-center gap-2">
              <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">{current}</span>
              <span class="text-[11px] text-[var(--text-muted)]">/ {target}</span>
            </div>
          </div>
        {/each}
      </div>
    </DetailSection>
  {/if}

  <ScalingBehaviorCard {spec} />

  <RelatedResourcesCard {resource} resourceType="hpa" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
