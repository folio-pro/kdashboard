<script lang="ts">
  import { Link, Globe, CheckCircle2, Unplug } from "lucide-svelte";
  import { onMount } from "svelte";
  import { invoke } from "$lib/ipc/core";
  import type { Resource, ResourceList } from "$lib/types";
  import { Button } from "$lib/components/ui";
  import DetailSection from "./DetailSection.svelte";
  import KvGrid from "./KvGrid.svelte";
  import KvField from "./KvField.svelte";
  import SummaryStrip from "./SummaryStrip.svelte";
  import SummaryCell from "./SummaryCell.svelte";
  import AttentionBlock from "./AttentionBlock.svelte";
  import ConditionsList from "./ConditionsList.svelte";
  import LinkRow from "./LinkRow.svelte";
  import RecentEventsCard from "./RecentEventsCard.svelte";
  import DetailColumns from "./DetailColumns.svelte";
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import PodContainerCards from "./PodContainerCards.svelte";
  import PodUsageCard from "./PodUsageCard.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import ProbesCard from "./ProbesCard.svelte";
  import InitContainersCard from "./InitContainersCard.svelte";
  import SecurityContextCard from "./SecurityContextCard.svelte";
  import TolerationsCard from "./TolerationsCard.svelte";
  import VolumesCard from "./VolumesCard.svelte";
  import PodPortForwarding from "./PodPortForwarding.svelte";
  import PodConfigSecrets from "./PodConfigSecrets.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { getRelatedResources, displayKind } from "$lib/utils/related-resources";
  import { extractConfigMapReferences, type SpecContainer, type ContainerStatus, type PortInfo } from "./pod-utils";
  import { podStatus, podReadyCount, podRestarts, podOwner, podProblem, orderedPodConditions } from "$lib/utils/pod-status";
  import { statusCategory, statusColor, isQuietStatus } from "$lib/components/table/status-category";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import { podProblemCopy } from "./pod-details.logic";

  /**
   * The pod overview, in reading order: what state it is in (summary strip),
   * why it is not healthy when it is not (attention block), its containers,
   * usage and ports, recent events; then the structural rail — conditions,
   * network, related objects, labels — and the rarely-read material collapsed
   * at the bottom. Metadata is last on purpose: a UID never answers "what is
   * wrong with this pod".
   */
  interface Props {
    resource: Resource;
    layout?: "page" | "aside";
  }

  let { resource, layout = "page" }: Props = $props();

  // --- Shared icon-error tracking (port-forward rows) ---
  let failedIcons: Set<string> = $state(new Set());

  function handleIconError(url: string) {
    if (failedIcons.has(url)) return;
    const next = new Set(failedIcons);
    next.add(url);
    failedIcons = next;
  }

  // --- Pod metadata ---
  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});
  let podIP = $derived((status.podIP as string) ?? "—");
  let hostIP = $derived((status.hostIP as string) ?? "—");
  let nodeName = $derived((spec.nodeName as string) ?? (status.nodeName as string) ?? "");
  let namespace = $derived(resource.metadata.namespace ?? "");

  let containerStatuses = $derived((status.containerStatuses as ContainerStatus[]) ?? []);
  let specContainers = $derived((spec.containers as SpecContainer[]) ?? []);
  let specContainerMap = $derived(new Map(specContainers.map((c) => [c.name, c])));

  // --- Derived state (kubectl-style) ---
  let podState = $derived(podStatus(resource));
  let stateCategory = $derived(statusCategory(podState.label));
  let ready = $derived(podReadyCount(resource));
  let restarts = $derived(podRestarts(resource));
  let owner = $derived(podOwner(resource));
  let problem = $derived(podProblem(resource));
  let problemCopy = $derived(problem ? podProblemCopy(problem) : null);
  let conditions = $derived(orderedPodConditions(resource));
  let ageTick = $derived(k8sStore.ageTick);

  function restartColor(count: number): string {
    if (count > 5) return "var(--status-failed)";
    if (count > 0) return "var(--status-pending)";
    return "var(--text-primary)";
  }

  // --- Volumes & config references ---
  let volumes = $derived(
    (spec.volumes as Array<{
      name: string;
      configMap?: { name: string; items?: Array<{ key: string }> };
      secret?: { secretName: string; items?: Array<{ key: string }> };
    }>) ?? [],
  );
  let configResources = $derived(extractConfigMapReferences(volumes, specContainers));

  // --- All container ports ---
  let allPorts = $derived.by(() => {
    const ports: PortInfo[] = [];
    for (const container of specContainers) {
      for (const port of container.ports ?? []) {
        const cp = port.containerPort ?? 0;
        if (cp > 0) ports.push({ containerName: container.name, containerPort: cp, protocol: port.protocol ?? "TCP" });
      }
    }
    return ports;
  });

  // --- Labels & annotations ---
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  // --- Related resources (owner / replicaset / service / node) ---
  // Services are loaded for reverse selector matching, like RelatedResourcesCard.
  let allServices = $state<Resource[]>([]);
  onMount(() => {
    let cancelled = false;
    invoke<ResourceList>("list_resources", {
      // Match services in the pod's own namespace, not the currently selected
      // one (they can differ when opening a pod via cross-link / All Namespaces).
      resourceType: "services",
      namespace: resource.metadata.namespace ?? k8sStore.currentNamespace,
    })
      .then((result) => {
        if (!cancelled) allServices = result.items;
      })
      .catch(() => {
        // non-critical — service relations just won't show
      });
    return () => {
      cancelled = true;
    };
  });

  let related = $derived(getRelatedResources(resource, "pods", allServices));

  const KIND_COLOR: Record<string, string> = {
    ReplicaSet: "var(--status-running)",
    Deployment: "var(--status-running)",
    StatefulSet: "var(--status-running)",
    DaemonSet: "var(--status-running)",
    Job: "var(--status-running)",
    CronJob: "var(--status-running)",
    Service: "var(--accent)",
    Ingress: "var(--accent)",
    Secret: "var(--status-pending)",
    Node: "var(--status-pending)",
  };
  const kindColor = (kind: string): string => KIND_COLOR[kind] ?? "var(--text-secondary)";

  function openOwner() {
    if (!owner) return;
    const type = related.find((r) => r.kind === owner.kind && r.name === owner.name)?.resourceType;
    if (type) openRelatedResourceTab(type, owner.name, namespace);
  }
</script>

<div class="select-text">
  <SummaryStrip>
    <SummaryCell label="Status" title={podState.reason ? `${podState.label} · ${podState.reason}` : podState.label}>
      {#if isQuietStatus(stateCategory)}
        <span class="truncate text-[12px] text-[var(--text-muted)]">{podState.label}</span>
      {:else}
        <span
          class="inline-flex max-w-full items-center gap-1.5 truncate rounded-sm px-1.5 text-[11px] font-medium leading-4"
          style="color: {statusColor(stateCategory)}; background-color: color-mix(in srgb, {statusColor(stateCategory)} 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, {statusColor(stateCategory)} 25%, transparent);"
        >
          <span class="h-[5px] w-[5px] shrink-0 rounded-full" style="background-color: {statusColor(stateCategory)}"></span>
          <span class="truncate">{podState.label}</span>
        </span>
      {/if}
    </SummaryCell>
    <SummaryCell label="Ready">
      <span
        class="font-mono text-[13px] tabular-nums"
        style:color={ready.total > 0 && ready.ready < ready.total ? "var(--status-pending)" : "var(--text-primary)"}
      >{ready.ready}/{ready.total}</span>
    </SummaryCell>
    <SummaryCell label="Restarts" title={restarts.lastAt ? `Last restart ${formatTimestamp(restarts.lastAt)}` : undefined}>
      <span class="font-mono text-[13px] tabular-nums" style:color={restartColor(restarts.count)}>{restarts.count}</span>
      {#if restarts.count > 0 && restarts.lastAt}
        {@const _tick = ageTick}
        <span class="ml-1.5 truncate font-mono text-[10px] text-[var(--text-muted)]">{formatAge(restarts.lastAt)} ago</span>
      {/if}
    </SummaryCell>
    <SummaryCell label="Age">
      {@const _tick = ageTick}
      <span class="font-mono text-[13px] tabular-nums text-[var(--text-primary)]">{formatAge(resource.metadata.creation_timestamp)}</span>
    </SummaryCell>
    <SummaryCell label="QoS" value={(status.qosClass as string) ?? "—"} mono={false} />
    {#if layout === "page"}
      <SummaryCell label="Pod IP" value={podIP} />
      <SummaryCell label="Node">
        {#if nodeName}
          <button type="button" class="truncate font-mono text-[13px] text-[var(--accent)] hover:underline" onclick={() => openRelatedResourceTab("nodes", nodeName)}>{nodeName}</button>
        {:else}
          <span class="text-[12px] text-[var(--text-muted)]">—</span>
        {/if}
      </SummaryCell>
      <SummaryCell label="Controlled by" title={owner ? `${owner.kind}/${owner.name}` : undefined}>
        {#if owner}
          <button type="button" class="truncate font-mono text-[13px] text-[var(--accent)] hover:underline" onclick={openOwner}>{owner.short}/{owner.name}</button>
        {:else}
          <span class="text-[12px] text-[var(--text-muted)]">—</span>
        {/if}
      </SummaryCell>
    {/if}
  </SummaryStrip>

  {#if problem && problemCopy}
    <AttentionBlock tone={problemCopy.tone} title={problemCopy.title}>
      {#each problemCopy.lines as line (line)}
        <span>{line}</span>
      {/each}
      {#snippet actions()}
        {#if problem.container}
          <Button variant="toolbar" size="xs" onclick={() => { uiStore.detailSubtab = "logs"; }}>Logs</Button>
        {/if}
        <Button variant="toolbar" size="xs" onclick={() => { uiStore.detailSubtab = "events"; }}>Events</Button>
      {/snippet}
    </AttentionBlock>
  {/if}

  <DetailColumns {layout}>
    {#snippet main()}
      <PodContainerCards {containerStatuses} {specContainerMap} />

      <PodUsageCard {resource} />

      {#if allPorts.length > 0}
        <DetailSection title="Port Forwarding" icon={Unplug}>
          <PodPortForwarding
            {allPorts}
            pod={resource}
            podName={resource.metadata.name}
            namespace={resource.metadata.namespace ?? "default"}
            {specContainerMap}
            {failedIcons}
            onIconError={handleIconError}
          />
        </DetailSection>
      {/if}

      {#if configResources.length > 0}
        <PodConfigSecrets {configResources} namespace={resource.metadata.namespace ?? ""} />
      {/if}

      <RecentEventsCard {resource} />
    {/snippet}

    {#snippet rail()}
      {#if conditions.length > 0}
        <DetailSection title="Conditions" icon={CheckCircle2}>
          <ConditionsList {conditions} layout={layout === "aside" ? "wrap" : "list"} />
        </DetailSection>
      {/if}

      <DetailSection title="Network" icon={Globe}>
        <KvGrid>
          <KvField label="Pod IP" value={podIP} />
          <KvField label="Host IP" value={hostIP} />
          <KvField label="Node">
            {#if nodeName}
              <button type="button" class="truncate text-left font-mono text-[13px] text-[var(--accent)] hover:underline" onclick={() => openRelatedResourceTab("nodes", nodeName)}>{nodeName}</button>
            {:else}
              <span class="font-mono text-[13px] text-[var(--text-muted)]">—</span>
            {/if}
          </KvField>
          <KvField label="Service Account" value={(spec.serviceAccountName as string) ?? "default"} />
          <KvField label="DNS Policy" value={(spec.dnsPolicy as string) ?? "—"} mono={false} />
          <KvField label="Restart Policy" value={(spec.restartPolicy as string) ?? "Always"} mono={false} />
        </KvGrid>
      </DetailSection>

      {#if related.length > 0}
        <DetailSection title="Related" icon={Link}>
          {#snippet actions()}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{related.length}</span>
          {/snippet}
          <div class="flex flex-col gap-2.5">
            {#each related as rel (`${rel.kind}/${rel.name}`)}
              <LinkRow
                kind={displayKind(rel.kind)}
                name={rel.name}
                color={kindColor(rel.kind)}
                onclick={rel.resourceType ? () => openRelatedResourceTab(rel.resourceType, rel.name, namespace) : undefined}
              />
            {/each}
          </div>
        </DetailSection>
      {/if}

      <LabelsSection {labels} />
    {/snippet}
  </DetailColumns>

  <!-- Rarely read, so collapsed: init containers, probes, security, scheduling, volumes, then metadata. -->
  <InitContainersCard {spec} {status} />
  <ProbesCard {spec} />
  <SecurityContextCard {spec} />
  <TolerationsCard {spec} />
  <VolumesCard {spec} />
  <CollapsibleCard title="Metadata">
    <div class="px-6 pt-1">
      <KvGrid>
        <KvField label="Name" value={resource.metadata.name} />
        {#if resource.metadata.namespace}
          <KvField label="Namespace" value={resource.metadata.namespace} />
        {/if}
        <KvField label="Created" value={resource.metadata.creation_timestamp} mono={false} />
        {#if resource.metadata.uid}
          <KvField label="UID" value={resource.metadata.uid} />
        {/if}
        {#if resource.metadata.resource_version}
          <KvField label="Resource Version" value={resource.metadata.resource_version} />
        {/if}
        {#if owner}
          <KvField label="Controlled By" value={`${owner.kind}/${owner.name}`} />
        {/if}
      </KvGrid>
    </div>
  </CollapsibleCard>
  <SmartAnnotationsCard {annotations} />
</div>
