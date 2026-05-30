<script lang="ts">
  import { Tag } from "lucide-svelte";
  import DetailSection from "./DetailSection.svelte";

  interface Props {
    labels: Record<string, string>;
    title?: string;
  }

  let { labels, title = "Labels" }: Props = $props();
</script>

{#if Object.keys(labels).length > 0}
  <DetailSection {title} icon={Tag}>
    <div class="flex flex-wrap gap-1.5">
      {#each Object.entries(labels) as [key, val]}
        <span class="inline-flex items-center rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
          {key}=<span class="ml-0.5 font-medium text-[var(--text-primary)]">{val}</span>
        </span>
      {/each}
    </div>
  </DetailSection>
{/if}
