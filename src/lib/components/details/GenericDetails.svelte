<script lang="ts">
  import { ChevronDown, ChevronRight, Layers } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import type { Resource } from "$lib/types";
  import InfoRow from "./InfoRow.svelte";
  import CollapsibleLabels from "./CollapsibleLabels.svelte";
  import EventsCard from "./EventsCard.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { formatAge, formatTimestamp } from "$lib/utils/age";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});
  let ownerRefs = $derived(resource.metadata.owner_references ?? []);

  let specExpanded = $state(false);

  function getSpecPreview(): string {
    try {
      const str = JSON.stringify(resource.spec ?? {}, null, 2);
      return str.length > 2000 ? str.slice(0, 2000) + "\n..." : str;
    } catch {
      return "{}";
    }
  }
</script>

<div class="mx-auto max-w-4xl space-y-6 p-7">
  <!-- Overview Card: Info + Owner Refs -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">{resource.kind}</h3>
    </div>
    <InfoRow label="Name" value={resource.metadata.name} />
    <InfoRow label="Namespace" value={resource.metadata.namespace ?? "-"} valueColor="var(--status-running)" />
    <InfoRow label="UID" value={resource.metadata.uid ?? "-"} />
    <InfoRow label="Version" value={resource.metadata.resource_version ?? "-"} />
    <InfoRow label="Age" value={formatAge(resource.metadata.creation_timestamp)} />
    <InfoRow label="Created" value={formatTimestamp(resource.metadata.creation_timestamp)} />

    <!-- Owner References inline -->
    {#if ownerRefs.length > 0}
      {#each ownerRefs as ref}
        {@const refType = kindToResourceType(ref.kind)}
        {#if refType}
          <InfoRow label="Owner">
            <button
              class="group flex items-center gap-1.5 transition-colors hover:opacity-80"
              onclick={() => openRelatedResourceTab(refType, ref.name, resource.metadata.namespace)}
            >
              <Layers class="h-3 w-3 shrink-0 text-[var(--status-running)]" />
              <span class="truncate font-mono text-[13px] font-medium text-[var(--accent)]">{ref.kind}/{ref.name}</span>
              <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-dimmed)] transition-transform group-hover:translate-x-0.5" />
            </button>
          </InfoRow>
        {:else}
          <InfoRow label="Owner" value="{ref.kind}/{ref.name}" />
        {/if}
      {/each}
    {/if}
  </div>

  <!-- Spec: collapsible -->
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <button
      class="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
      onclick={() => specExpanded = !specExpanded}
    >
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Spec</h3>
      <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-dimmed)] transition-transform", specExpanded && "rotate-180")} />
    </button>
    {#if specExpanded}
      <div class="border-t border-[var(--border-hover)] p-5">
        <pre class="max-h-80 overflow-auto rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] p-4 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{getSpecPreview()}</pre>
      </div>
    {/if}
  </div>

  <!-- Related Resources -->
  <RelatedResourcesCard {resource} resourceType={kindToResourceType(resource.kind)} />

  <!-- Events -->
  <EventsCard {resource} />

  <!-- Labels & Annotations -->
  <CollapsibleLabels {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
