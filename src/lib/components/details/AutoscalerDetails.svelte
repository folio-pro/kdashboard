<script lang="ts">
  // One panel for HorizontalPodAutoscaler, VerticalPodAutoscaler and Datadog's
  // WatermarkPodAutoscaler. The three differ in where they keep their numbers,
  // not in what an operator wants from them: what is the metric doing, and how
  // many pods is that asking for. `autoscalerSummary` flattens the difference;
  // this file only decides how to paint the answer.

  import { Badge } from "$lib/components/ui";
  import { Boxes, Gauge, Sliders } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import { autoscalerSummary, type AutoscalerFlavor, type AutoscalerTarget } from "$lib/utils/autoscaler";
  import { usageBarColor } from "$lib/stores/metrics.logic";
  import { liveValues } from "$lib/stores/live-values.svelte";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import ScalingBehaviorCard from "./ScalingBehaviorCard.svelte";
  import UsageSparkline from "./UsageSparkline.svelte";
  import { prometheusHistory, PROMETHEUS_HINT } from "$lib/stores/prometheus-series.svelte";

  interface Props {
    resource: Resource;
    flavor: AutoscalerFlavor;
  }

  let { resource, flavor }: Props = $props();

  let summary = $derived(autoscalerSummary(resource, flavor));
  let spec = $derived(resource.spec ?? {});
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  // Per-flavour wording, as a table rather than ternaries scattered between
  // the script and the template — all three readings of "what this section is"
  // sit together and can be compared.
  const FLAVOR_UI: Record<AutoscalerFlavor, { section: string; empty: string }> = {
    hpa: { section: "Metrics", empty: "This autoscaler declares no metrics." },
    wpa: { section: "Watermarks", empty: "This autoscaler declares no metrics." },
    vpa: {
      section: "Recommendations",
      empty: "The recommender has not produced a recommendation for this target yet.",
    },
  };
  let copy = $derived(FLAVOR_UI[flavor]);

  // The panel's resource is replaced by the same watch deltas that feed the
  // table, so the flash the table shows is available here too.
  let flash = $derived(liveValues.rowFlash(resource.metadata.uid, Date.now()));

  /**
   * Where a replica count sits on the min..max track, as a percentage. A track
   * with no room (min === max) pins everything to the left rather than
   * dividing by zero.
   */
  function trackPosition(value: number): number {
    const min = summary.min ?? 0;
    const max = summary.max ?? min;
    if (max <= min) return 0;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  let showReplicas = $derived(summary.max !== null);
  let current = $derived(summary.current ?? 0);
  let desired = $derived(summary.desired ?? current);

  function barColor(target: AutoscalerTarget): string {
    return target.percent === null ? "var(--text-muted)" : usageBarColor(target.percent);
  }

  // WPA's own knobs — not HPA `behavior`, which ScalingBehaviorCard renders.
  // Every field is optional and several are bare numbers whose unit only lives
  // in the CRD's field name, so the suffix is carried here rather than left for
  // the reader to guess.
  const WPA_TUNING: Array<{ key: string; label: string; suffix: string }> = [
    { key: "algorithm", label: "Algorithm", suffix: "" },
    { key: "tolerance", label: "Tolerance", suffix: "" },
    { key: "scaleUpLimitFactor", label: "Scale Up Limit", suffix: "%" },
    { key: "scaleDownLimitFactor", label: "Scale Down Limit", suffix: "%" },
    { key: "upscaleForbiddenWindowSeconds", label: "Upscale Window", suffix: "s" },
    { key: "downscaleForbiddenWindowSeconds", label: "Downscale Window", suffix: "s" },
    { key: "readinessDelaySeconds", label: "Readiness Delay", suffix: "s" },
  ];

  let wpaTuning = $derived(
    flavor !== "wpa"
      ? []
      : WPA_TUNING.filter(({ key }) => spec[key] !== undefined && spec[key] !== null).map(
          ({ label, key, suffix }) => ({ label, value: `${String(spec[key])}${suffix}` }),
        ),
  );

  // Replica history. kube-state-metrics only publishes these series for HPAs,
  // so the chart is an HPA-only extra rather than something the panel pretends
  // to offer for all three.
  const history = prometheusHistory(() => {
    if (flavor !== "hpa") return null;
    const selector =
      `namespace="${resource.metadata.namespace ?? ""}",` +
      `horizontalpodautoscaler="${resource.metadata.name}"`;
    return [
      `kube_horizontalpodautoscaler_status_current_replicas{${selector}}`,
      `kube_horizontalpodautoscaler_status_desired_replicas{${selector}}`,
    ];
  });

  /** Replica counts are whole pods; a "2.5" on the axis would be a lie. */
  const formatReplicaCount = (v: number): string => String(Math.round(v));
</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title={showReplicas ? "Scaling" : "Target"} icon={Boxes}>
    {#snippet actions()}
      {#if summary.dryRun}
        <Badge appearance="surface" bordered mono title="The autoscaler evaluates its metrics but never scales">Dry run</Badge>
      {/if}
      {#if summary.limitedReason}
        <Badge appearance="surface" bordered mono title="The autoscaler wants to scale further but cannot">{summary.limitedReason}</Badge>
      {/if}
    {/snippet}

    <KvGrid>
      <KvField label="Target">
        <span class="font-mono text-[13px] text-[var(--text-primary)]">{summary.reference}</span>
      </KvField>
      {#if showReplicas}
        <KvField label="Min Replicas" value={summary.min} />
        <KvField label="Max Replicas" value={summary.max} />
        <KvField label="Current">
          <span class="font-mono text-[13px] text-[var(--text-primary)] {flash.replicas ? 'animate-value-flash' : ''}">{summary.current ?? "—"}</span>
        </KvField>
        <KvField label="Desired">
          <!-- Amber only while the two disagree: that gap IS the pending scale,
               and it is the one number worth looking at on this panel. -->
          <span class="font-mono text-[13px] {desired !== current ? 'text-[var(--status-pending)]' : 'text-[var(--text-primary)]'} {flash.replicas ? 'animate-value-flash' : ''}">{summary.desired ?? "—"}</span>
        </KvField>
      {/if}
      {#if summary.updateMode}
        <KvField label="Update Mode" value={summary.updateMode} />
      {/if}
      {#if summary.lastScaleTime}
        <KvField label="Last Scale" value={summary.lastScaleTime} />
      {/if}
    </KvGrid>

    {#if showReplicas && summary.max !== null}
      <!-- The replica track: how much of the autoscaler's allowance is in use,
           and where it is heading. Reading "3 of 2..10, heading to 5" off a
           grid of four numbers takes a moment; off this it does not. -->
      <div class="mt-4 flex flex-col gap-1.5">
        <div class="relative h-1.5 w-full rounded-full bg-[var(--bg-tertiary)]">
          <div
            class="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
            style="width: {trackPosition(current)}%"
          ></div>
          {#if desired !== current}
            <div
              class="absolute -top-[3px] h-3 w-[2px] rounded-full bg-[var(--status-pending)]"
              style="left: {trackPosition(desired)}%"
              title="Desired: {desired}"
            ></div>
          {/if}
        </div>
        <div class="flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
          <span>min {summary.min ?? 0}</span>
          <span class="text-[var(--text-secondary)]">
            {current} running{desired !== current ? ` → ${desired} wanted` : ""}
          </span>
          <span>max {summary.max}</span>
        </div>
      </div>
    {/if}
  </DetailSection>

  <DetailSection title={copy.section} icon={Gauge}>
    {#snippet actions()}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{summary.targets.length}</span>
    {/snippet}

    {#if summary.targets.length === 0}
      <p class="text-[12px] text-[var(--text-muted)]">{copy.empty}</p>
    {:else}
      <div class="flex flex-col gap-2">
        {#each summary.targets as target, i (`${i}:${target.source}:${target.name}`)}
          <div class="flex flex-col gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2.5">
                <span class="truncate text-[13px] font-medium text-[var(--text-primary)]">{target.name}</span>
                <Badge appearance="surface" bordered mono>{target.source}</Badge>
              </div>
              <div class="flex shrink-0 items-baseline gap-2">
                <span class="font-mono text-[13px] font-medium text-[var(--text-primary)] {flash.targets ? 'animate-value-flash' : ''}">{target.currentLabel}</span>
                <span class="text-[11px] text-[var(--text-muted)]">/ {target.targetLabel}</span>
              </div>
            </div>

            {#if summary.hasMeter}
              <div class="relative h-[3px] w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                {#if target.percent !== null}
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    style="width: {Math.min(target.percent, 100)}%; background-color: {barColor(target)}"
                  ></div>
                {/if}
                {#if target.lowPercent !== null}
                  <!-- Below this mark a watermark autoscaler scales down; the
                       stretch between it and the far end is the quiet band. -->
                  <div
                    class="absolute inset-y-0 w-px bg-[var(--text-muted)]"
                    style="left: {Math.min(target.lowPercent, 100)}%"
                    title="Low watermark"
                  ></div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </DetailSection>

  {#if flavor === "hpa" && showReplicas}
    <DetailSection title="Replica History" icon={Boxes}>
      {#if !history.configured}
        <p class="text-[11px] text-[var(--text-muted)]">{PROMETHEUS_HINT}</p>
      {:else if history.error}
        <p class="text-[11px] text-[var(--status-failed)]">{history.error}</p>
      {:else if !history.hasSamples}
        <p class="text-[11px] text-[var(--text-muted)]">
          No series for this autoscaler. The chart reads kube-state-metrics, which
          only publishes replica counts for HorizontalPodAutoscalers.
        </p>
      {:else}
        <!-- Running beside wanted: the two curves separating IS a scaling
             event, and the gap between them is how long it took to close. -->
        <div class="grid grid-cols-2 gap-6">
          <div class="flex flex-col gap-1">
            <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Running</span>
            <UsageSparkline samples={history.series[0] ?? []} format={formatReplicaCount} />
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Wanted</span>
            <UsageSparkline samples={history.series[1] ?? []} format={formatReplicaCount} color="var(--status-pending)" />
          </div>
        </div>
      {/if}
    </DetailSection>
  {/if}

  {#if wpaTuning.length > 0}
    <DetailSection title="Tuning" icon={Sliders}>
      <KvGrid>
        {#each wpaTuning as field (field.label)}
          <KvField label={field.label} value={field.value} />
        {/each}
      </KvGrid>
    </DetailSection>
  {/if}

  {#if summary.conditions.length > 0}
    <CollapsibleConditions conditions={summary.conditions} />
  {/if}

  {#if flavor === "hpa"}
    <ScalingBehaviorCard {spec} />
  {/if}

  <RelatedResourcesCard {resource} resourceType={flavor} />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
