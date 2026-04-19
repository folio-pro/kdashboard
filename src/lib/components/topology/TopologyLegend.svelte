<script lang="ts">
  import type { TopologyNode } from "$lib/types";
  import { KIND_COLORS, DEFAULT_KIND_COLOR } from "$lib/utils/k8s-colors";

  interface Props {
    nodes: TopologyNode[];
  }

  let { nodes }: Props = $props();

  let activeKinds = $derived(
    [...new Set(nodes.map(n => n.kind))]
      .sort()
      .map(kind => ({ kind, color: KIND_COLORS[kind] ?? DEFAULT_KIND_COLOR }))
  );
</script>

<div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 px-3 py-2 backdrop-blur-sm">
  <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
    Legend
  </div>
  <div class="flex flex-wrap gap-x-3 gap-y-1">
    {#each activeKinds as { kind, color }}
      <div class="flex items-center gap-1.5">
        <div class="h-2.5 w-2.5 rounded-sm" style="background-color: {color};"></div>
        <span class="text-[10px] text-[var(--text-secondary)]">{kind}</span>
      </div>
    {/each}
    {#if nodes.some(n => n.is_ghost)}
      <div class="flex items-center gap-1.5">
        <div class="h-2.5 w-2.5 rounded-sm border border-dashed border-[var(--text-muted)]"></div>
        <span class="text-[10px] text-[var(--text-muted)]">Ghost</span>
      </div>
    {/if}
  </div>
</div>
