<script lang="ts">
  import { Layers, ChevronRight } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import InfoRow from "./InfoRow.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import IncidentTimeline from "./IncidentTimeline.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import ProbesCard from "./ProbesCard.svelte";
  import InitContainersCard from "./InitContainersCard.svelte";
  import SecurityContextCard from "./SecurityContextCard.svelte";
  import TolerationsCard from "./TolerationsCard.svelte";
  import VolumesCard from "./VolumesCard.svelte";
  import PodPortForwarding from "./PodPortForwarding.svelte";
  import PodConfigSecrets from "./PodConfigSecrets.svelte";
  import PodContainers from "./PodContainers.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { extractConfigMapReferences, type SpecContainer, type ContainerStatus, type PortInfo } from "./pod-utils";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  // --- Shared icon-error tracking ---
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
  let phase = $derived((status.phase as string) ?? "Unknown");
  let podIP = $derived((status.podIP as string) ?? "-");
  let nodeName = $derived((spec.nodeName as string) ?? (status.nodeName as string) ?? "-");

  let containerStatuses = $derived(
    (status.containerStatuses as ContainerStatus[]) ?? []
  );
  let specContainers = $derived(
    (spec.containers as SpecContainer[]) ?? []
  );
  let specContainerMap = $derived(new Map(specContainers.map(c => [c.name, c])));

  let restartCount = $derived(
    containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0)
  );
  let ownerDeployment = $derived(
    resource.metadata.owner_references?.find(
      (ref) => ref.kind === "ReplicaSet" || ref.kind === "Deployment"
    )
  );
  let namespaceLabel = $derived(
    resource.metadata.labels?.["app.kubernetes.io/part-of"] ??
    resource.metadata.labels?.["app.kubernetes.io/name"] ??
    resource.metadata.labels?.["app"] ??
    resource.metadata.namespace ??
    ""
  );

  // --- Volumes & config references ---
  let volumes = $derived((spec.volumes as Array<{
    name: string;
    configMap?: { name: string; items?: Array<{ key: string }> };
    secret?: { secretName: string; items?: Array<{ key: string }> };
  }>) ?? []);

  let configResources = $derived(extractConfigMapReferences(volumes, specContainers));

  // --- All container ports ---
  let allPorts = $derived.by(() => {
    const ports: PortInfo[] = [];
    for (const container of specContainers) {
      for (const port of container.ports ?? []) {
        const cp = port.containerPort ?? 0;
        if (cp > 0) {
          ports.push({
            containerName: container.name,
            containerPort: cp,
            protocol: port.protocol ?? "TCP",
          });
        }
      }
    }
    return ports;
  });

  // --- Labels & annotations ---
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
      <StatusBadge status={phase} />
    </div>

    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={namespaceLabel} valueColor="var(--status-running)" />
    <InfoRow label="Node" value={nodeName} />
    <InfoRow label="IP Address" value={podIP} />
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />
    <InfoRow label="Restarts" value={String(restartCount)} valueColor={restartCount > 0 ? 'var(--status-pending)' : 'var(--status-running)'} />
    {#if ownerDeployment}
      {@const ownerType = kindToResourceType(ownerDeployment.kind)}
      <InfoRow label="Owner">
        {#if ownerType}
          <button
            class="group flex items-center gap-1.5 transition-colors hover:opacity-80"
            onclick={() => openRelatedResourceTab(ownerType, ownerDeployment.name, resource.metadata.namespace)}
          >
            <Layers class="h-3 w-3 shrink-0 text-[var(--status-running)]" />
            <span class="truncate text-[13px] font-medium text-[var(--accent)]">{ownerDeployment.kind}/{ownerDeployment.name}</span>
            <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-dimmed)] transition-transform group-hover:translate-x-0.5" />
          </button>
        {:else}
          <span class="text-[13px] font-medium text-[var(--text-primary)]">{ownerDeployment.kind}/{ownerDeployment.name}</span>
        {/if}
      </InfoRow>
    {/if}
    <InfoRow label="QoS Class" value={(status.qosClass as string) ?? "-"} />
    <InfoRow label="Restart Policy" value={(spec.restartPolicy as string) ?? "Always"} />
    <InfoRow label="Service Account" value={(spec.serviceAccountName as string) ?? "default"} />
    <InfoRow label="DNS Policy" value={(spec.dnsPolicy as string) ?? "-"} />
  </div>

  <!-- Port Forward Card -->
  <PodPortForwarding
    {allPorts}
    podName={resource.metadata.name}
    namespace={resource.metadata.namespace ?? "default"}
    {specContainerMap}
    {failedIcons}
    onIconError={handleIconError}
  />

  <!-- ConfigMaps & Secrets Card -->
  <PodConfigSecrets
    {configResources}
    namespace={resource.metadata.namespace ?? ""}
  />

  <!-- Containers Card -->
  <PodContainers
    {containerStatuses}
    {specContainerMap}
    {failedIcons}
    onIconError={handleIconError}
  />

  <!-- Init Containers -->
  <InitContainersCard {spec} {status} />

  <!-- Health Probes -->
  <ProbesCard {spec} />

  <!-- Security Context -->
  <SecurityContextCard {spec} />

  <!-- Tolerations & Affinity -->
  <TolerationsCard {spec} />

  <!-- Volumes -->
  <VolumesCard {spec} />

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="pods" />

  <!-- Activity Timeline -->
  <IncidentTimeline {resource} />

  <!-- Labels & Annotations -->
  <SmartAnnotationsCard annotations={annotations} />
  <CollapsibleLabels {labels} />
</div>
