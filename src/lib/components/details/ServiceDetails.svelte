<script lang="ts">
  import { Globe } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let spec = $derived(resource.spec ?? {});
  let status = $derived(resource.status ?? {});

  let serviceType = $derived((spec.type as string) ?? "ClusterIP");
  let clusterIP = $derived((spec.clusterIP as string) ?? "-");
  let externalIPs = $derived((spec.externalIPs as string[]) ?? []);
  let externalName = $derived((spec.externalName as string) ?? null);
  let sessionAffinity = $derived((spec.sessionAffinity as string) ?? "None");

  let loadBalancerIngress = $derived(
    ((status.loadBalancer as { ingress?: Array<{ ip?: string; hostname?: string }> })?.ingress) ?? []
  );

  let ports = $derived(
    (spec.ports as Array<{
      name?: string;
      protocol?: string;
      port?: number;
      targetPort?: string | number;
      nodePort?: number;
    }>) ?? []
  );

  let selectorStr = $derived(Object.entries((spec.selector as Record<string, string>) ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "-");
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  let hasNodePorts = $derived(ports.some((p) => p.nodePort));

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <!-- Service Spec -->
  <DetailSection title="Service Spec" icon={Globe}>
    <KvGrid>
      <KvField label="Type">
        <span class="inline-flex w-fit items-center rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">{serviceType}</span>
      </KvField>
      <KvField label="Cluster IP" value={clusterIP} />
      <KvField label="Selector" value={selectorStr} />
      <KvField label="Session Affinity" value={sessionAffinity} mono={false} />
      {#if spec.ipFamilyPolicy}
        <KvField label="IP Family Policy" value={spec.ipFamilyPolicy as string} mono={false} />
      {/if}
      {#if spec.internalTrafficPolicy}
        <KvField label="Internal Traffic" value={spec.internalTrafficPolicy as string} mono={false} />
      {/if}
      {#if spec.externalTrafficPolicy}
        <KvField label="External Traffic" value={spec.externalTrafficPolicy as string} mono={false} />
      {/if}
      {#if externalName}
        <KvField label="External Name" value={externalName} />
      {/if}
      {#if externalIPs.length > 0}
        <KvField label="External IPs" value={externalIPs.join(", ")} />
      {/if}
      {#if loadBalancerIngress.length > 0}
        <KvField label="Load Balancer" value={loadBalancerIngress.map((i) => i.ip ?? i.hostname ?? "").join(", ")} />
      {/if}
    </KvGrid>
  </DetailSection>

  <!-- Ports -->
  <DetailSection title="Ports" icon={Globe}>
    {#snippet actions()}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{ports.length}</span>
    {/snippet}
    {#if ports.length > 0}
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-[var(--border-color)]">
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Name</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Protocol</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Port</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Target</th>
            {#if hasNodePorts}
              <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Node Port</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each ports as port}
            <tr class="border-b border-[var(--border-color)] last:border-b-0">
              <td class="px-3 py-2.5 text-[12px] font-medium text-[var(--text-primary)]">{port.name ?? "-"}</td>
              <td class="px-3 py-2.5 font-mono text-[12px] text-[var(--text-secondary)]">{port.protocol ?? "TCP"}</td>
              <td class="px-3 py-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)]">{port.port ?? "-"}</td>
              <td class="px-3 py-2.5 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">{port.targetPort ?? "-"}</td>
              {#if hasNodePorts}
                <td class="px-3 py-2.5 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">{port.nodePort ?? "-"}</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="text-[12px] text-[var(--text-muted)]">No ports configured</p>
    {/if}
  </DetailSection>

  <RelatedResourcesCard {resource} resourceType="services" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
