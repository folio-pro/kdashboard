<script lang="ts">
  import type { Resource } from "$lib/types";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import { kindToResourceType } from "$lib/utils/related-resources";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  function getSpecPreview(): string {
    try {
      const str = JSON.stringify(resource.spec ?? {}, null, 2);
      return str.length > 2000 ? str.slice(0, 2000) + "\n..." : str;
    } catch {
      return "{}";
    }
  }
</script>

<div class="select-text">
  <MetadataSection {resource} />

  <!-- Spec (raw) -->
  <CollapsibleCard title="Spec">
    <div class="px-6 pb-2">
      <pre class="max-h-80 overflow-auto rounded-sm border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{getSpecPreview()}</pre>
    </div>
  </CollapsibleCard>

  <RelatedResourcesCard {resource} resourceType={kindToResourceType(resource.kind)} />

  <LabelsSection {labels} />
  <SmartAnnotationsCard annotations={annotations} />
</div>
