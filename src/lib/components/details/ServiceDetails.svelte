<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import EventsCard from "./EventsCard.svelte";
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

  let selector = $derived((spec.selector as Record<string, string>) ?? {});
  let selectorStr = $derived(Object.entries((spec.selector as Record<string, string>) ?? {}).map(([k,v]) => `${k}=${v}`).join(", ") || "-");
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  let hasNodePorts = $derived(ports.some(p => p.nodePort));
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
      <Badge variant="outline">{serviceType}</Badge>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Cluster IP" value={clusterIP} />
    <InfoRow label="Selector" value={selectorStr} />
    <InfoRow label="Session Affinity" value={sessionAffinity} />
    {#if spec.ipFamilyPolicy}
      <InfoRow label="IP Family Policy" value={spec.ipFamilyPolicy as string} />
    {/if}
    {#if spec.internalTrafficPolicy}
      <InfoRow label="Internal Traffic" value={spec.internalTrafficPolicy as string} />
    {/if}
    {#if spec.externalTrafficPolicy}
      <InfoRow label="External Traffic" value={spec.externalTrafficPolicy as string} />
    {/if}
    {#if externalName}
      <InfoRow label="External Name" value={externalName} />
    {/if}
    {#if externalIPs.length > 0}
      <InfoRow label="External IPs" value={externalIPs.join(", ")} />
    {/if}
    {#if loadBalancerIngress.length > 0}
      <InfoRow label="Load Balancer" value={loadBalancerIngress.map((i) => i.ip ?? i.hostname ?? "").join(", ")} />
    {/if}
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />
  </div>

  <!-- Ports Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Ports</h3>
      <span class="text-[11px] text-[var(--text-muted)]">{ports.length} ports</span>
    </div>
    {#if ports.length > 0}
      <div class="border-t border-[var(--border-hover)]">
        <table class="w-full">
          <thead>
            <tr class="border-b border-[var(--border-hover)]">
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Name</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Protocol</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Port</th>
              <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Target</th>
              {#if hasNodePorts}
                <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Node Port</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each ports as port}
              <tr class="border-b border-[var(--border-hover)] last:border-b-0">
                <td class="px-4 py-2.5 text-[12px] font-medium text-[var(--text-primary)]">{port.name ?? "-"}</td>
                <td class="px-4 py-2.5">
                  <Badge variant="secondary">{port.protocol ?? "TCP"}</Badge>
                </td>
                <td class="px-4 py-2.5 font-mono text-[12px] text-[var(--text-primary)]">{port.port ?? "-"}</td>
                <td class="px-4 py-2.5 font-mono text-[12px] text-[var(--text-secondary)]">{port.targetPort ?? "-"}</td>
                {#if hasNodePorts}
                  <td class="px-4 py-2.5 font-mono text-[12px] text-[var(--text-secondary)]">{port.nodePort ?? "-"}</td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="border-t border-[var(--border-hover)] px-5 py-3.5">
        <p class="text-xs text-[var(--text-muted)]">No ports configured</p>
      </div>
    {/if}
  </div>

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="services" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels labels={labels} selector={selector} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
