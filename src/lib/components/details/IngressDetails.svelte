<script lang="ts">
  import { ChevronRight, ChevronDown } from "lucide-svelte";
  import { cn } from "$lib/utils";
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
          backend?: {
            service?: { name?: string; port?: { number?: number; name?: string } };
          };
        }>;
      };
    }>) ?? []
  );

  let tls = $derived(
    (spec.tls as Array<{
      hosts?: string[];
      secretName?: string;
    }>) ?? []
  );

  let loadBalancerIngress = $derived(
    ((status.loadBalancer as { ingress?: Array<{ ip?: string; hostname?: string }> })?.ingress) ?? []
  );

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  let tlsExpanded = $state(false);
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Overview</h3>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="Ingress Class" value={ingressClassName ?? "-"} />
    {#if loadBalancerIngress.length > 0}
      <InfoRow label="Load Balancer" value={loadBalancerIngress.map((i) => i.ip ?? i.hostname ?? "").join(", ")} />
    {/if}
    <InfoRow label="Created" value={resource.metadata.creation_timestamp} />

    {#if defaultBackend}
      <div class="border-t border-[var(--border-hover)] px-5 py-4">
        <div class="flex items-center gap-2">
          <span class="text-xs text-[var(--text-dimmed)]">Default Backend:</span>
          {#if defaultBackend.service}
            <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">
              {defaultBackend.service.name ?? "-"}:{defaultBackend.service.port?.number ?? defaultBackend.service.port?.name ?? "-"}
            </span>
          {:else if defaultBackend.resource}
            <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">
              {defaultBackend.resource.kind ?? ""}/${defaultBackend.resource.name ?? ""}
            </span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- TLS: collapsible -->
    {#if tls.length > 0}
      <div class="border-t border-[var(--border-hover)]">
        <button
          class="flex w-full items-center justify-between px-5 py-3 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
          onclick={() => tlsExpanded = !tlsExpanded}
        >
          <span class="text-xs font-medium text-[var(--text-dimmed)]">TLS</span>
          <div class="flex items-center gap-2">
            <span class="text-xs text-[var(--text-muted)]">{tls.length} entries</span>
            <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-dimmed)] transition-transform", tlsExpanded && "rotate-180")} />
          </div>
        </button>
        {#if tlsExpanded}
          {#each tls as tlsEntry}
            <div class="flex flex-col gap-2 border-t border-[var(--border-hover)] px-5 py-3">
              <div class="flex items-center gap-2">
                <span class="text-xs text-[var(--text-dimmed)]">Secret:</span>
                <span class="font-mono text-[12px] font-medium text-[var(--text-primary)]">{tlsEntry.secretName ?? "-"}</span>
              </div>
              {#if tlsEntry.hosts && tlsEntry.hosts.length > 0}
                <div class="flex flex-wrap gap-1.5">
                  {#each tlsEntry.hosts as host}
                    <span class="rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)]">{host}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <!-- Rules Card -->
  {#if rules.length > 0}
    <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div class="flex items-center justify-between px-5 py-4">
        <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Rules</h3>
        <span class="text-[11px] text-[var(--text-muted)]">{rules.length} rules</span>
      </div>
      {#each rules as rule}
        <div class="flex flex-col gap-3 border-t border-[var(--border-hover)] p-5">
          <span class="text-sm font-semibold text-[var(--text-primary)]">{rule.host ?? "*"}</span>
          {#if rule.http?.paths}
            {#each rule.http.paths as path}
              <div class="flex items-center gap-2.5 rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-4 py-3">
                <Badge variant="outline" class="text-[10px]">{path.pathType ?? "Prefix"}</Badge>
                <span class="font-mono text-[13px] text-[var(--text-secondary)]">{path.path ?? "/"}</span>
                <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-dimmed)]" />
                <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">
                  {path.backend?.service?.name ?? "?"}:{path.backend?.service?.port?.number ?? path.backend?.service?.port?.name ?? "?"}
                </span>
              </div>
            {/each}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType="ingresses" />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
