<script lang="ts">
  import { Info, ChevronRight, Layers } from "lucide-svelte";
  import type { Resource } from "$lib/types";
  import { formatAge } from "$lib/utils/age";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let ownerRefs = $derived(resource.metadata.owner_references ?? []);

</script>

<DetailSection title="Metadata" icon={Info}>
  <KvGrid>
    <KvField label="Name" value={resource.metadata.name} />
    {#if resource.metadata.namespace}
      <KvField label="Namespace" value={resource.metadata.namespace} />
    {/if}
    <KvField label="Created" value={resource.metadata.creation_timestamp} mono={false} />
    <KvField label="Age" value={formatAge(resource.metadata.creation_timestamp)} />
    {#if resource.metadata.uid}
      <KvField label="UID" value={resource.metadata.uid} />
    {/if}
    {#if resource.metadata.resource_version}
      <KvField label="Resource Version" value={resource.metadata.resource_version} />
    {/if}
    {#each ownerRefs as ref}
      {@const refType = kindToResourceType(ref.kind)}
      <KvField label="Controlled By">
        {#if refType}
          <button
            class="group flex items-center gap-1.5 text-left"
            onclick={() => openRelatedResourceTab(refType, ref.name, resource.metadata.namespace)}
          >
            <Layers class="h-3 w-3 shrink-0 text-[var(--accent)]" />
            <span class="truncate font-mono text-[13px] text-[var(--accent)] group-hover:underline">{ref.kind}/{ref.name}</span>
            <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-dimmed)] transition-transform group-hover:translate-x-0.5" />
          </button>
        {:else}
          <span class="font-mono text-[13px] text-[var(--text-primary)]">{ref.kind}/{ref.name}</span>
        {/if}
      </KvField>
    {/each}
  </KvGrid>
</DetailSection>
