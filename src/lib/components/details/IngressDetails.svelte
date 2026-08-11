<script lang="ts">
  import { ChevronRight, Network, Lock } from "lucide-svelte";
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

  let ingressClassName = $derived((spec.ingressClassName as string) ?? null);

  let defaultBackend = $derived(
    (spec.defaultBackend as {
      service?: { name?: string; port?: { number?: number; name?: string } };
      resource?: { apiGroup?: string; kind?: string; name?: string };
    }) ?? null
  );

  let rules = $derived(
    (spec.rules as Array<{
      host?: string;
      http?: {
        paths?: Array<{
          path?: string;
          pathType?: string;
          backend?: { service?: { name?: string; port?: { number?: number; name?: string } } };
        }>;
      };
    }>) ?? []
  );

  let tls = $derived((spec.tls as Array<{ hosts?: string[]; secretName?: string }>) ?? []);

  let loadBalancerIngress = $derived(
    ((status.loadBalancer as { ingress?: Array<{ ip?: string; hostname?: string }> })?.ingress) ?? []
  );

  let defaultBackendStr = $derived(
    defaultBackend?.service
      ? `${defaultBackend.service.name ?? "-"}:${defaultBackend.service.port?.number ?? defaultBackend.service.port?.name ?? "-"}`
      : defaultBackend?.resource
        ? `${defaultBackend.resource.kind ?? ""}/${defaultBackend.resource.name ?? ""}`
        : null
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="Ingress Spec" icon={Network}>
    <KvGrid>
      <KvField label="Ingress Class" value={ingressClassName ?? "-"} />
      {#if loadBalancerIngress.length > 0}
        <KvField label="Load Balancer" value={loadBalancerIngress.map((i) => i.ip ?? i.hostname ?? "").join(", ")} />
      {/if}
      {#if defaultBackendStr}
        <KvField label="Default Backend" value={defaultBackendStr} />
      {/if}
    </KvGrid>
  </DetailSection>

  {#if tls.length > 0}
    <DetailSection title="TLS" icon={Lock}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{tls.length}</span>
      {/snippet}
      <div class="flex flex-col gap-2.5">
        {#each tls as tlsEntry}
          <div class="flex flex-col gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-[var(--text-muted)]">Secret:</span>
              <span class="font-mono text-[12px] font-medium text-[var(--text-primary)]">{tlsEntry.secretName ?? "-"}</span>
            </div>
            {#if tlsEntry.hosts && tlsEntry.hosts.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each tlsEntry.hosts as host}
                  <span class="rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)]">{host}</span>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </DetailSection>
  {/if}

  {#if rules.length > 0}
    <DetailSection title="Rules" icon={Network}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{rules.length}</span>
      {/snippet}
      <div class="flex flex-col gap-4">
        {#each rules as rule}
          <div class="flex flex-col gap-2">
            <span class="text-[13px] font-semibold text-[var(--text-primary)]">{rule.host ?? "*"}</span>
            {#if rule.http?.paths}
              {#each rule.http.paths as path}
                <div class="flex items-center gap-2.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
                  <span class="inline-flex items-center rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">{path.pathType ?? "Prefix"}</span>
                  <span class="font-mono text-[13px] text-[var(--text-secondary)]">{path.path ?? "/"}</span>
                  <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                  <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">{path.backend?.service?.name ?? "?"}:{path.backend?.service?.port?.number ?? path.backend?.service?.port?.name ?? "?"}</span>
                </div>
              {/each}
            {/if}
          </div>
        {/each}
      </div>
    </DetailSection>
  {/if}

  <RelatedResourcesCard {resource} resourceType="ingresses" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
