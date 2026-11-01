<script lang="ts">
  import type { TopologyNode } from "$lib/types";
  import { nodeStateColor } from "./topology-state";

  interface Props {
    nodes: TopologyNode[];
  }

  let { nodes }: Props = $props();

  // Only what the graph shows: a healthy namespace has no key to read.
  let states = $derived(nodes.map(nodeStateColor).filter((c) => c !== null));
  let failing = $derived(states.includes("var(--status-failed)"));
  let degraded = $derived(states.some((c) => c !== "var(--status-failed)"));
  let hasGhost = $derived(nodes.some((n) => n.is_ghost));
</script>

<span class="ml-2 flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
  {#if degraded}
    <span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-[var(--status-pending)]"></span>Degraded</span>
  {/if}
  {#if failing}
    <span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-[var(--status-failed)]"></span>Failing</span>
  {/if}
  {#if hasGhost}
    <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-[2px] border border-dashed border-[var(--text-muted)]"></span>Ghost</span>
  {/if}
</span>
