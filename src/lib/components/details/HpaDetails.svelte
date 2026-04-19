<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import InlineStat from "./InlineStat.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import EventsCard from "./EventsCard.svelte";
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
      pods?: {
        metric?: { name?: string };
        target?: { type?: string; averageValue?: string };
      };
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
      resource?: {
        name?: string;
        current?: { averageUtilization?: number; averageValue?: string };
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

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Target">
      <div class="flex items-center gap-2">
        <Badge variant="secondary">{scaleTargetRef.kind ?? "Unknown"}</Badge>
        <span class="truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">{scaleTargetRef.name ?? "-"}</span>
      </div>
    </InfoRow>
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />

    <!-- Replicas -->
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <div class="flex items-center gap-4">
        <InlineStat label="Min" value={minReplicas} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Max" value={maxReplicas} />
        <span class="text-[var(--border-hover)]">·</span>
        <InlineStat label="Current" value={currentReplicas} />
        <span class="text-[var(--border-hover)]">/</span>
        <InlineStat label="Desired" value={desiredReplicas} color={desiredReplicas !== currentReplicas ? "var(--status-pending)" : undefined} />
      </div>
    </div>

    <CollapsibleConditions {conditions} />
  </div>

  <!-- Metrics Card -->
  {#if metrics.length > 0}
    <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div class="flex items-center justify-between px-5 py-4">
        <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Metrics</h3>
        <span class="text-[11px] text-[var(--text-muted)]">{metrics.length} metrics</span>
      </div>
      {#each metrics as metric}
        {@const metricName = metric.resource?.name ?? metric.pods?.metric?.name ?? metric.object?.metric?.name ?? "unknown"}
        {@const current = metric.type === "Resource" && metric.resource?.name ? getCurrentForMetric(metric.resource.name) : "-"}
        {@const target = getTargetForMetric(metric)}
        <div class="flex items-center justify-between border-t border-[var(--border-hover)] px-5 py-3.5">
          <div class="flex items-center gap-2.5">
            <span class="text-[13px] font-semibold text-[var(--text-primary)]">{metricName}</span>
            <Badge variant="secondary">{metric.type ?? "Resource"}</Badge>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-mono text-sm font-bold text-[var(--text-primary)]">{current}</span>
            <span class="text-xs text-[var(--text-dimmed)]">/ {target}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Scaling Behavior -->
  <ScalingBehaviorCard {spec} />

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="hpa" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
