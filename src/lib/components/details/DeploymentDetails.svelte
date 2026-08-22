<script lang="ts">
  import type { Resource } from "$lib/types";
  import { invoke } from "$lib/ipc/core";
  import { Box, History, Layers, Link, Scale, Tag } from "lucide-svelte";
  import { Badge } from "$lib/components/ui";
  import SummaryStrip from "./SummaryStrip.svelte";
  import SummaryCell from "./SummaryCell.svelte";
  import DetailColumns from "./DetailColumns.svelte";
  import DetailSection from "./DetailSection.svelte";
  import ConditionsList from "./ConditionsList.svelte";
  import LinkRow from "./LinkRow.svelte";
  import RecentEventsCard from "./RecentEventsCard.svelte";
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import KvGrid from "./KvGrid.svelte";
  import KvField from "./KvField.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import StrategyCard from "./StrategyCard.svelte";
  import RevisionHistoryCard from "./RevisionHistoryCard.svelte";
  import ReplicaBar from "$lib/components/common/ReplicaBar.svelte";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import { deploymentStatus, replicaSegments, shortImage, templateImages } from "$lib/utils/workload-status";
  import { podReadyCount, podRestarts, podStatus } from "$lib/utils/pod-status";
  import { autoscalerSummary, formatTargets } from "$lib/utils/autoscaler";
  import { formatBytes } from "$lib/stores/metrics.logic";
  import { metricsStore } from "$lib/stores/metrics.svelte";
  import { statusCategory, statusColor, isQuietStatus } from "$lib/components/table/status-category";
  import { splitPodName } from "$lib/components/table/table-filter";
  import { navigateToResourceTable, openRelatedResourceTab, openResourceDetail } from "$lib/actions/navigation";
  import {
    deploymentRevision,
    findAutoscalerFor,
    requestTotals,
    servicesSelecting,
    strategyLabel,
    templateContainerRows,
    templateReferences,
    type TemplateReference,
  } from "./deployment-details.logic";

  interface Props {
    resource: Resource;
    layout?: "page" | "aside";
  }

  let { resource, layout = "page" }: Props = $props();
  let page = $derived(layout === "page");

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});
  let namespace = $derived(resource.metadata.namespace ?? "");

  let health = $derived(deploymentStatus(resource));
  let segments = $derived(replicaSegments(resource));
  let revision = $derived(deploymentRevision(resource));
  let strategy = $derived(strategyLabel(resource));
  let images = $derived(templateImages(resource));
  let updatedReplicas = $derived((status.updatedReplicas as number) ?? 0);
  let rollingOut = $derived(updatedReplicas < segments.desired);

  let selector = $derived(
    (spec.selector as { matchLabels?: Record<string, string> })?.matchLabels ?? {}
  );
  let selectorTerms = $derived(Object.entries(selector).map(([k, v]) => `${k}=${v}`));
  let selectorString = $derived(selectorTerms.join(","));
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  let conditions = $derived(
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? []
  );

  let containerRows = $derived(templateContainerRows(resource));
  let totals = $derived(requestTotals(resource));
  let references = $derived(templateReferences(resource));

  // --- Pods of the selector --------------------------------------------------
  let pods = $state<Resource[]>([]);
  let podsLoading = $state(false);

  $effect(() => {
    const sel = selectorString;
    const ns = namespace;
    let cancelled = false;
    if (!sel) {
      pods = [];
      return;
    }
    podsLoading = true;
    invoke<{ items: Resource[] }>("list_pods_by_selector", { namespace: ns, selector: sel })
      .then((result) => { if (!cancelled) pods = result.items; })
      .catch(() => { if (!cancelled) pods = []; })
      .finally(() => { if (!cancelled) podsLoading = false; });
    return () => { cancelled = true; };
  });

  // Keep the per-pod memory column fresh while the panel is open.
  $effect(() => {
    void namespace;
    void metricsStore.loadPodMetrics(namespace || null);
  });
  let podUsageKnown = $derived(pods.some((p) => metricsStore.getPodUsage(p.metadata.namespace, p.metadata.name)));

  // --- HPA and Services in the namespace (one list each, matched locally) ---
  let autoscalers = $state<Resource[]>([]);
  let services = $state<Resource[]>([]);
  $effect(() => {
    const ns = namespace;
    let cancelled = false;
    invoke<{ items: Resource[] }>("list_resources", { resourceType: "hpa", namespace: ns })
      .then((r) => { if (!cancelled) autoscalers = r.items; })
      .catch(() => { if (!cancelled) autoscalers = []; });
    invoke<{ items: Resource[] }>("list_resources", { resourceType: "services", namespace: ns })
      .then((r) => { if (!cancelled) services = r.items; })
      .catch(() => { if (!cancelled) services = []; });
    return () => { cancelled = true; };
  });
  let hpa = $derived(findAutoscalerFor(resource, autoscalers));
  let hpaSummary = $derived(hpa ? autoscalerSummary(hpa, "hpa") : null);
  let matchedServices = $derived(servicesSelecting(resource, services));

  const REF_COLOR: Record<TemplateReference["kind"], string> = {
    ConfigMap: "var(--status-running)",
    Secret: "var(--status-pending)",
    ServiceAccount: "var(--status-pending)",
    PersistentVolumeClaim: "var(--text-secondary)",
  };
  const REF_TYPE: Record<TemplateReference["kind"], string> = {
    ConfigMap: "configmaps",
    Secret: "secrets",
    ServiceAccount: "serviceaccounts",
    PersistentVolumeClaim: "persistentvolumeclaims",
  };

  function podRestartsColor(n: number): string {
    return n > 5 ? "var(--status-failed)" : n > 0 ? "var(--status-pending)" : "var(--text-muted)";
  }
</script>

{#snippet statusPill(label: string, detail?: string)}
  {@const category = statusCategory(label)}
  <span class="flex min-w-0 items-center gap-1.5">
    {#if isQuietStatus(category)}
      <span class="truncate text-[12px] text-[var(--text-muted)]">{label}</span>
    {:else}
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium leading-4"
        style="color: {statusColor(category)}; background-color: color-mix(in srgb, {statusColor(category)} 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, {statusColor(category)} 25%, transparent);"
      >
        <span class="h-[5px] w-[5px] shrink-0 rounded-full" style="background-color: {statusColor(category)}"></span>
        {label}
      </span>
    {/if}
    {#if detail}
      <span class="truncate text-[11px] text-[var(--text-muted)]" title={detail}>{detail}</span>
    {/if}
  </span>
{/snippet}

<div class="select-text">
  <SummaryStrip>
    <SummaryCell label="Status" title={health.detail}>
      {@render statusPill(health.label, page ? health.detail : undefined)}
    </SummaryCell>
    <SummaryCell label="Replicas">
      <span class="flex items-center gap-2">
        <span
          class="font-mono text-[13px] tabular-nums"
          style:color={segments.ready < segments.desired ? "var(--status-pending)" : "var(--text-primary)"}
        >{segments.ready}/{segments.desired}</span>
        <ReplicaBar ready={segments.ready} pending={segments.pending} missing={segments.missing} class="w-12" />
      </span>
    </SummaryCell>
    <SummaryCell label="Revision" value={revision === null ? "—" : `#${revision}`} />
    <SummaryCell label="Strategy" value={strategy} mono={false} />
    {#if page}
      <SummaryCell label="Autoscaling">
        {#if hpaSummary}
          <span class="flex items-center gap-1.5 overflow-hidden">
            <span class="font-mono text-[13px] tabular-nums text-[var(--text-primary)]">HPA {hpaSummary.min ?? "?"}–{hpaSummary.max ?? "?"}</span>
            <span class="truncate font-mono text-[11px] text-[var(--text-muted)]">{formatTargets(hpaSummary, 1)}</span>
          </span>
        {:else}
          <span class="text-[12px] text-[var(--text-muted)]">—</span>
        {/if}
      </SummaryCell>
      <SummaryCell label="Images">
        {#if images.length === 0}
          <span class="text-[12px] text-[var(--text-muted)]">—</span>
        {:else}
          <span class="flex items-center gap-1">
            <Badge appearance="surface" size="sm" bordered mono class="max-w-[160px] truncate px-1.5" title={images[0]}>{shortImage(images[0])}</Badge>
            {#if images.length > 1}
              <Badge appearance="surface" size="sm" bordered mono class="px-1.5" title={images.slice(1).join(", ")}>+{images.length - 1}</Badge>
            {/if}
          </span>
        {/if}
      </SummaryCell>
      <SummaryCell label="Selector" value={selectorTerms.join(", ") || "—"} />
      <SummaryCell label="Pods" value={podsLoading && pods.length === 0 ? "…" : pods.length} />
    {/if}
    <SummaryCell label="Age" value={formatAge(resource.metadata.creation_timestamp)} />
  </SummaryStrip>

  <DetailColumns {layout}>
    {#snippet main()}
      <!-- Rollout: the bar, the counts, the conditions, then the ReplicaSets as revisions. -->
      <DetailSection title="Rollout" icon={History}>
        {#snippet actions()}
          {#if spec.paused}
            <span class="font-mono text-[11px] text-[var(--status-pending)]">paused</span>
          {/if}
        {/snippet}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-3 text-[11px] text-[var(--text-muted)]">
              <span class="truncate">
                {#if rollingOut}
                  rev {revision === null ? "?" : revision - 1} → {revision ?? "?"} · {updatedReplicas} of {segments.desired} updated
                {:else if revision !== null}
                  rev {revision} · up to date
                {:else}
                  up to date
                {/if}
              </span>
              <span class="shrink-0 font-mono tabular-nums">{segments.ready} ready · {segments.pending} not ready · {segments.missing} missing</span>
            </div>
            <ReplicaBar ready={segments.ready} pending={segments.pending} missing={segments.missing} height={6} class="w-full" />
          </div>
          {#if conditions.length > 0}
            <ConditionsList {conditions} layout="list" />
          {/if}
        </div>
      </DetailSection>
      <RevisionHistoryCard {resource} />

      <!-- Pods of the selector -->
      <DetailSection title="Pods" icon={Box}>
        {#snippet actions()}
          <button
            type="button"
            class="text-[11px] text-[var(--accent)] hover:underline"
            onclick={() => navigateToResourceTable("Pods", "pods")}
            title="Open the Pods table"
          >open in Pods</button>
          <span class="font-mono text-[11px] text-[var(--text-muted)]">{podsLoading && pods.length === 0 ? "…" : pods.length}</span>
        {/snippet}
        {#if pods.length > 0}
          <div class="overflow-x-auto">
          <table class="w-full border-collapse text-[12px]">
            <thead>
              <tr class="border-b border-[var(--border-color)] text-left text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
                <th class="pb-1.5 pr-3 font-medium">Name</th>
                <th class="pb-1.5 pr-3 font-medium">Status</th>
                <th class="pb-1.5 pr-3 text-right font-medium">Ready</th>
                <th class="pb-1.5 pr-3 text-right font-medium" title="Restarts">↻</th>
                {#if podUsageKnown}<th class="pb-1.5 pr-3 text-right font-medium">Mem</th>{/if}
                {#if page}<th class="pb-1.5 pr-3 font-medium">Node</th>{/if}
                <th class="pb-1.5 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {#each pods as pod (pod.metadata.uid)}
                {@const st = podStatus(pod)}
                {@const ready = podReadyCount(pod)}
                {@const restarts = podRestarts(pod)}
                {@const name = splitPodName(pod.metadata.name)}
                {@const usage = metricsStore.getPodUsage(pod.metadata.namespace, pod.metadata.name)}
                <tr
                  class="cursor-pointer border-b border-[var(--hairline)] transition-colors last:border-b-0 hover:bg-[var(--table-row-hover)]"
                  onclick={() => openResourceDetail(pod, "pods")}
                >
                  <td class="max-w-[220px] truncate py-2 pr-3 font-medium text-[var(--text-primary)]" title={pod.metadata.name}>
                    {name.base}<span class="font-normal text-[var(--text-muted)]">{name.suffix}</span>
                  </td>
                  <td class="py-2 pr-3">{@render statusPill(st.label, st.reason)}</td>
                  <td class="py-2 pr-3 text-right font-mono tabular-nums" style:color={ready.ready < ready.total ? "var(--status-pending)" : "var(--text-secondary)"}>{ready.ready}/{ready.total}</td>
                  <td class="py-2 pr-3 text-right font-mono tabular-nums" style:color={podRestartsColor(restarts.count)}>{restarts.count}</td>
                  {#if podUsageKnown}
                    <td class="py-2 pr-3 text-right font-mono tabular-nums text-[var(--text-secondary)]">{usage ? formatBytes(usage.memory_bytes) : "—"}</td>
                  {/if}
                  {#if page}
                    <td class="max-w-[160px] truncate py-2 pr-3 font-mono text-[11px] text-[var(--text-muted)]">{(pod.spec?.nodeName as string) ?? "—"}</td>
                  {/if}
                  <td class="py-2 text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)]">{formatAge(pod.metadata.creation_timestamp)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          </div>
        {:else if !podsLoading}
          <p class="text-[12px] text-[var(--text-muted)]">No pods match the selector</p>
        {/if}
      </DetailSection>

      <!-- What the template runs -->
      {#if containerRows.length > 0}
        <DetailSection title="Template · containers" icon={Layers}>
          {#snippet actions()}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{containerRows.length}</span>
          {/snippet}
          <div class="flex flex-col gap-2.5">
            <div class="overflow-x-auto">
            <table class="w-full border-collapse text-[12px]">
              <thead>
                <tr class="border-b border-[var(--border-color)] text-left text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
                  <th class="pb-1.5 pr-3 font-medium">Container</th>
                  <th class="pb-1.5 pr-3 font-medium">CPU req / lim</th>
                  <th class="pb-1.5 pr-3 font-medium">Mem req / lim</th>
                  {#if page}<th class="pb-1.5 pr-3 font-medium">Ports</th>{/if}
                  <th class="pb-1.5 pr-3 font-medium">Probes</th>
                  <th class="pb-1.5 text-right font-medium">Env</th>
                </tr>
              </thead>
              <tbody>
                {#each containerRows as row (row.name)}
                  <tr class="border-b border-[var(--hairline)] last:border-b-0">
                    <td class="max-w-[220px] py-2 pr-3">
                      <div class="flex flex-col">
                        <span class="font-medium text-[var(--text-primary)]">{row.name}</span>
                        <span class="truncate font-mono text-[11px] text-[var(--text-muted)]" title={row.image}>{shortImage(row.image)}</span>
                      </div>
                    </td>
                    <td class="py-2 pr-3 font-mono tabular-nums text-[var(--text-secondary)]">{row.cpu}</td>
                    <td class="py-2 pr-3 font-mono tabular-nums text-[var(--text-secondary)]">{row.memory}</td>
                    {#if page}<td class="py-2 pr-3 font-mono tabular-nums text-[var(--text-secondary)]">{row.ports}</td>{/if}
                    <td class="py-2 pr-3">
                      <span class="inline-flex gap-1">
                        <Badge appearance="surface" size="sm" bordered mono class="px-1.5" title="Liveness probe {row.probes.liveness ? 'configured' : 'not configured'}" style={row.probes.liveness ? "" : "opacity: .4;"}>L</Badge>
                        <Badge appearance="surface" size="sm" bordered mono class="px-1.5" title="Readiness probe {row.probes.readiness ? 'configured' : 'not configured'}" style={row.probes.readiness ? "" : "opacity: .4;"}>R</Badge>
                        <Badge appearance="surface" size="sm" bordered mono class="px-1.5" title="Startup probe {row.probes.startup ? 'configured' : 'not configured'}" style={row.probes.startup ? "" : "opacity: .4;"}>S</Badge>
                      </span>
                    </td>
                    <td class="py-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">{row.envCount}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
              <span>Request per pod <span class="font-mono text-[var(--text-secondary)]">{totals.perPodLabel}</span></span>
              <span>× {totals.replicas} {totals.replicas === 1 ? "replica" : "replicas"} = <span class="font-mono text-[var(--text-secondary)]">{totals.totalLabel}</span></span>
            </div>
          </div>
        </DetailSection>
      {/if}

      <RecentEventsCard {resource} />
    {/snippet}

    {#snippet rail()}
      <!-- Scaling: the HPA that owns the replica count, if any -->
      <DetailSection title="Scaling" icon={Scale}>
        {#if hpa && hpaSummary}
          <div class="flex flex-col gap-2.5">
            <div class="flex items-center justify-between gap-3">
              <LinkRow kind="HPA" name={hpa.metadata.name} color="var(--status-running)" onclick={() => openRelatedResourceTab("hpa", hpa!.metadata.name, namespace)} />
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
              <span>current <span class="text-[var(--text-primary)]">{hpaSummary.current ?? "—"}</span></span>
              <span>min <span class="text-[var(--text-primary)]">{hpaSummary.min ?? "—"}</span></span>
              <span>max <span class="text-[var(--text-primary)]">{hpaSummary.max ?? "—"}</span></span>
            </div>
            {#if hpaSummary.targets.length > 0}
              <div class="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
                {#each hpaSummary.targets as t (t.name)}
                  <div class="flex items-center justify-between gap-3">
                    <span class="truncate">{t.name}</span>
                    <span class="shrink-0 font-mono tabular-nums text-[var(--text-secondary)]">{t.currentLabel} / {t.targetLabel}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if hpaSummary.lastScaleTime}
              <span class="text-[11px] text-[var(--text-muted)]">Last scale {formatAge(hpaSummary.lastScaleTime)} ago · scaling the Deployment by hand will be overridden.</span>
            {/if}
          </div>
        {:else}
          <p class="text-[12px] text-[var(--text-muted)]">No autoscaler targets this deployment</p>
        {/if}
      </DetailSection>

      <StrategyCard {spec} kind="Deployment" />

      <!-- Related: the services in front, the config behind -->
      {#if matchedServices.length > 0 || references.length > 0}
        <DetailSection title="Related" icon={Link}>
          {#snippet actions()}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{matchedServices.length + references.length}</span>
          {/snippet}
          <div class="flex flex-col gap-2.5">
            {#each matchedServices as svc (svc.metadata.uid)}
              <LinkRow kind="Service" name={svc.metadata.name} color="var(--accent)" onclick={() => openRelatedResourceTab("services", svc.metadata.name, namespace)} />
            {/each}
            {#each references as ref (`${ref.kind}/${ref.name}`)}
              <LinkRow kind={ref.kind === "PersistentVolumeClaim" ? "PVC" : ref.kind} name={ref.name} color={REF_COLOR[ref.kind]} onclick={() => openRelatedResourceTab(REF_TYPE[ref.kind], ref.name, namespace)} />
            {/each}
          </div>
        </DetailSection>
      {/if}

      <!-- Selector and labels -->
      <DetailSection title="Selector · labels" icon={Tag}>
        <div class="flex flex-col gap-2.5">
          {#if selectorTerms.length > 0}
            <span class="text-[11px] text-[var(--text-muted)]">Selector</span>
            <div class="flex flex-wrap gap-1.5">
              {#each selectorTerms as term (term)}
                <Badge appearance="surface" size="sm" bordered mono class="px-1.5">{term}</Badge>
              {/each}
            </div>
          {/if}
          {#if Object.keys(labels).length > 0}
            <span class="text-[11px] text-[var(--text-muted)]">Labels</span>
            <div class="flex flex-wrap gap-1.5">
              {#each Object.entries(labels) as [key, val] (key)}
                <span class="inline-flex items-center rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
                  {key}=<span class="ml-0.5 font-medium text-[var(--text-primary)]">{val}</span>
                </span>
              {/each}
            </div>
          {/if}
        </div>
      </DetailSection>
    {/snippet}
  </DetailColumns>

  <!-- Rarely read: metadata and annotations, collapsed at the foot. -->
  <CollapsibleCard title="Metadata">
    <div class="px-6 pt-1">
      <KvGrid>
        <KvField label="Name" value={resource.metadata.name} />
        {#if resource.metadata.namespace}
          <KvField label="Namespace" value={resource.metadata.namespace} />
        {/if}
        <KvField label="Created" value={formatTimestamp(resource.metadata.creation_timestamp)} mono={false} />
        {#if resource.metadata.uid}
          <KvField label="UID" value={resource.metadata.uid} />
        {/if}
        {#if resource.metadata.resource_version}
          <KvField label="Resource version" value={resource.metadata.resource_version} />
        {/if}
        {#if spec.paused}
          <KvField label="Paused">
            <span class="font-mono text-[13px] text-[var(--status-pending)]">true</span>
          </KvField>
        {/if}
      </KvGrid>
    </div>
  </CollapsibleCard>
  <SmartAnnotationsCard annotations={annotations} />
</div>
