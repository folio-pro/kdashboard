<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import { Server, Cpu, Ban } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import NodePodsCard from "./NodePodsCard.svelte";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});

  let nodeInfo = $derived(
    (status.nodeInfo as {
      osImage?: string;
      operatingSystem?: string;
      architecture?: string;
      kernelVersion?: string;
      containerRuntimeVersion?: string;
      kubeletVersion?: string;
      kubeProxyVersion?: string;
    }) ?? {}
  );

  let capacity = $derived((status.capacity as Record<string, string>) ?? {});
  let allocatable = $derived((status.allocatable as Record<string, string>) ?? {});

  let conditions = $derived(
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? []
  );

  let addresses = $derived((status.addresses as Array<{ type: string; address: string }>) ?? []);

  let taints = $derived(
    (spec.taints as Array<{ key: string; value?: string; effect: string }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  const resourceKeys = ["cpu", "memory", "ephemeral-storage", "pods"];

  function isConditionHealthy(type: string, conditionStatus: string): boolean {
    if (type === "Ready") return conditionStatus === "True";
    return conditionStatus !== "True";
  }

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="Node Info" icon={Server}>
    <KvGrid>
      <KvField label="OS Image" value={nodeInfo.osImage ?? "-"} mono={false} />
      <KvField label="Architecture" value={nodeInfo.architecture ?? "-"} />
      <KvField label="Kernel" value={nodeInfo.kernelVersion ?? "-"} />
      <KvField label="Runtime" value={nodeInfo.containerRuntimeVersion ?? "-"} />
      <KvField label="Kubelet" value={nodeInfo.kubeletVersion ?? "-"} />
      {#each addresses as addr}
        <KvField label={addr.type} value={addr.address} />
      {/each}
      {#if spec.podCIDR}
        <KvField label="Pod CIDR" value={spec.podCIDR as string} />
      {/if}
      {#if spec.unschedulable}
        <KvField label="Unschedulable">
          <span class="font-mono text-[13px] text-[var(--status-pending)]">Yes (Cordoned)</span>
        </KvField>
      {/if}
    </KvGrid>
  </DetailSection>

  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} healthFn={isConditionHealthy} />
  {/if}

  <DetailSection title="Resources" icon={Cpu}>
    <table class="w-full border-collapse text-[13px]">
      <thead>
        <tr class="border-b border-[var(--border-color)]">
          <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]" style="width: 160px;">Resource</th>
          <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Capacity</th>
          <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Allocatable</th>
        </tr>
      </thead>
      <tbody>
        {#each resourceKeys as key}
          {#if capacity[key] || allocatable[key]}
            <tr class="border-b border-[var(--border-color)] last:border-b-0">
              <td class="px-3 py-2.5 text-[12px] font-medium text-[var(--text-muted)]">{key}</td>
              <td class="px-3 py-2.5 font-mono text-[13px] text-[var(--text-primary)]">{capacity[key] ?? "-"}</td>
              <td class="px-3 py-2.5 font-mono text-[13px] text-[var(--text-primary)]">{allocatable[key] ?? "-"}</td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </DetailSection>

  {#if taints.length > 0}
    <DetailSection title="Taints" icon={Ban}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{taints.length}</span>
      {/snippet}
      <div class="flex flex-col gap-2">
        {#each taints as taint}
          <div class="flex items-center gap-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <Badge appearance="surface" bordered mono>{taint.effect}</Badge>
            <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{taint.key}{taint.value ? `=${taint.value}` : ""}</span>
          </div>
        {/each}
      </div>
    </DetailSection>
  {/if}

  <NodePodsCard nodeName={resource.metadata.name} />

  <RelatedResourcesCard {resource} resourceType="nodes" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
