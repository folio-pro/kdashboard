<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import EventsCard from "./EventsCard.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";

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
    (status.conditions as Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }>) ?? []
  );

  let addresses = $derived(
    (status.addresses as Array<{
      type: string;
      address: string;
    }>) ?? []
  );

  let taints = $derived(
    (spec.taints as Array<{
      key: string;
      value?: string;
      effect: string;
    }>) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  const resourceKeys = ["cpu", "memory", "ephemeral-storage", "pods"];

  function isConditionHealthy(type: string, conditionStatus: string): boolean {
    if (type === "Ready") return conditionStatus === "True";
    return conditionStatus !== "True";
  }
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
      <div class="flex items-center gap-1.5">
        {#each conditions as condition}
          <span
            class="h-1.5 w-1.5 rounded-full"
            style:background-color={isConditionHealthy(condition.type, condition.status) ? "var(--status-running)" : "var(--status-failed)"}
            title="{condition.type}: {condition.status}"
          ></span>
        {/each}
      </div>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="OS Image" value={nodeInfo.osImage ?? "-"} />
    <InfoRow label="Architecture" value={nodeInfo.architecture ?? "-"} />
    <InfoRow label="Kernel" value={nodeInfo.kernelVersion ?? "-"} />
    <InfoRow label="Runtime" value={nodeInfo.containerRuntimeVersion ?? "-"} />
    <InfoRow label="Kubelet" value={nodeInfo.kubeletVersion ?? "-"} />
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />
    {#if spec.unschedulable}<InfoRow label="Unschedulable" value="Yes (Cordoned)" valueColor="var(--status-pending)" />{/if}
    {#if spec.podCIDR}<InfoRow label="Pod CIDR" value={spec.podCIDR as string} />{/if}

    {#if addresses.length > 0}
      {#each addresses as addr}
        <InfoRow label={addr.type} value={addr.address} />
      {/each}
    {/if}

    <CollapsibleConditions {conditions} healthFn={isConditionHealthy} />
  </div>

  <!-- Resources Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Resources</h3>
    </div>
    <div class="flex h-10 items-center border-t border-[var(--border-hover)] bg-[var(--bg-primary)] px-5">
      <div class="w-[140px] shrink-0 text-[11px] font-semibold text-[var(--text-dimmed)]">Resource</div>
      <div class="flex-1 text-[11px] font-semibold text-[var(--text-dimmed)]">Capacity</div>
      <div class="flex-1 text-[11px] font-semibold text-[var(--text-dimmed)]">Allocatable</div>
    </div>
    {#each resourceKeys as key}
      {#if capacity[key] || allocatable[key]}
        <div class="flex h-11 items-center border-t border-[var(--border-hover)] px-5">
          <div class="w-[140px] shrink-0 text-xs font-medium text-[var(--text-dimmed)]">{key}</div>
          <div class="flex-1 font-mono text-[13px] font-medium text-[var(--text-primary)]">{capacity[key] ?? "-"}</div>
          <div class="flex-1 font-mono text-[13px] font-medium text-[var(--text-primary)]">{allocatable[key] ?? "-"}</div>
        </div>
      {/if}
    {/each}
  </div>

  {#if taints.length > 0}
    <!-- Taints Card -->
    <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div class="flex items-center justify-between px-5 py-4">
        <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Taints</h3>
        <span class="text-xs text-[var(--text-muted)]">{taints.length}</span>
      </div>
      {#each taints as taint}
        <div class="flex items-center gap-3.5 border-t border-[var(--border-hover)] px-5 py-3.5">
          <Badge variant="secondary" class="text-[10px]">{taint.effect}</Badge>
          <span class="truncate font-mono text-[11px] text-[var(--text-primary)]">
            {taint.key}{taint.value ? `=${taint.value}` : ""}
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="nodes" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
