<script lang="ts">
  import { Box, Link, FileText, Lock, GitBranch, Database, Copy, Globe, Server, Network, Layers, Unplug } from "lucide-svelte";
  import { onMount } from "svelte";
  import { invoke } from "$lib/ipc/core";
  import type { Resource, ResourceList } from "$lib/types";
  import type { IconComponent } from "$lib/actions/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvGrid from "./KvGrid.svelte";
  import KvField from "./KvField.svelte";
  import RelCard from "./RelCard.svelte";
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
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { getRelatedResources } from "$lib/utils/related-resources";
  import { extractConfigMapReferences, type SpecContainer, type ContainerStatus, type PortInfo } from "./pod-utils";

  const KIND_ICON: Record<string, IconComponent> = {
    ConfigMap: FileText, Secret: Lock, Deployment: Layers, ReplicaSet: GitBranch,
    StatefulSet: Database, DaemonSet: Copy, Service: Globe, Node: Server,
    Pod: Box, Ingress: Network,
  };
  const kindIcon = (kind: string): IconComponent => KIND_ICON[kind] ?? Box;

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

  let readyCount = $derived(containerStatuses.filter((c) => c.ready).length);
  let totalContainers = $derived(containerStatuses.length);

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
    }).then((result) => {
      if (!cancelled) allServices = result.items;
    }).catch(() => {
      // non-critical — service relations just won't show
    });
    return () => { cancelled = true; };
  });

  let related = $derived(getRelatedResources(resource, "pods", allServices));
</script>

<div class="select-text">
  <MetadataSection {resource} />

  <!-- Pod Spec -->
  <DetailSection title="Pod Spec" icon={Box}>
    <KvGrid>
      <KvField label="Status">
        <StatusBadge status={phase} />
      </KvField>
      <KvField label="Pod IP" value={podIP} />
      <KvField label="Node" value={nodeName} />
      <KvField label="QoS Class" value={(status.qosClass as string) ?? "—"} />
      <KvField label="Ready" value={`${readyCount}/${totalContainers}`} />
      <KvField label="Restarts">
        <span class="font-mono text-[13px] {restartCount > 5 ? 'text-[var(--status-failed)]' : restartCount > 0 ? 'text-[var(--status-pending)]' : 'text-[var(--text-primary)]'}">{restartCount}</span>
      </KvField>
      <KvField label="Restart Policy" value={(spec.restartPolicy as string) ?? "Always"} mono={false} />
      <KvField label="Service Account" value={(spec.serviceAccountName as string) ?? "default"} />
      <KvField label="DNS Policy" value={(spec.dnsPolicy as string) ?? "—"} mono={false} />
    </KvGrid>
  </DetailSection>

  <PodUsageCard {resource} />

  <PodContainerCards {containerStatuses} {specContainerMap} />

  <!-- Port Forwarding -->
  {#if allPorts.length > 0}
    <DetailSection title="Port Forwarding" icon={Unplug}>
      <PodPortForwarding
        {allPorts}
        podName={resource.metadata.name}
        namespace={resource.metadata.namespace ?? "default"}
        {specContainerMap}
        {failedIcons}
        onIconError={handleIconError}
      />
    </DetailSection>
  {/if}

  <!-- Config & Secrets — inline, expandable key/value viewer -->
  {#if configResources.length > 0}
    <PodConfigSecrets
      {configResources}
      namespace={resource.metadata.namespace ?? ""}
    />
  {/if}

  <!-- Related Resources -->
  {#if related.length > 0}
    <DetailSection title="Related Resources" icon={Link}>
      <div class="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(252px,1fr))]">
        {#each related as rel}
          <RelCard
            icon={kindIcon(rel.kind)}
            kind={rel.kind}
            name={rel.name}
            onclick={() => openRelatedResourceTab(rel.resourceType, rel.name, resource.metadata.namespace)}
          />
        {/each}
      </div>
    </DetailSection>
  {/if}

  <LabelsSection {labels} />

  <!-- Extended detail — rich functional sections beyond the reference scope -->
  <InitContainersCard {spec} {status} />
  <ProbesCard {spec} />
  <SecurityContextCard {spec} />
  <TolerationsCard {spec} />
  <VolumesCard {spec} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
