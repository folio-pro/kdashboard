<script lang="ts">
  import type { TopologyNode } from "$lib/types";
  import { KIND_SHORT } from "$lib/utils/k8s-colors";
  import { nodeStateColor } from "./topology-state";

  interface Props {
    node: TopologyNode;
    x: number;
    y: number;
    width: number;
    height: number;
    selected: boolean;
    dimmed: boolean;
    onmouseenter: () => void;
    onmouseleave: () => void;
    onclick: () => void;
  }

  let { node, x, y, width, height, selected, dimmed, onmouseenter, onmouseleave, onclick }: Props = $props();

  let stateColor = $derived(nodeStateColor(node));
  // The tail is what tells two replicas apart, so it survives the cut.
  let displayName = $derived(
    node.name.length > 28 ? `${node.name.slice(0, 22)}…${node.name.slice(-5)}` : node.name
  );
  let kindLabel = $derived(KIND_SHORT[node.kind] ?? node.kind);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<g
  transform="translate({x}, {y})"
  class="cursor-pointer transition-opacity duration-150"
  opacity={dimmed ? 0.25 : 1}
  {onmouseenter}
  {onmouseleave}
  {onclick}
>
  <!-- Colour means state, and healthy is the quiet case: a node only takes a
       colour when it needs a look. The kind is in the label. -->
  <rect
    x="0" y="0"
    {width} {height}
    rx="8"
    fill="var(--bg-secondary)"
    stroke={selected ? "var(--accent)" : node.is_ghost ? "var(--text-muted)" : stateColor ?? "var(--border-hover)"}
    stroke-width={selected ? 2 : 1}
    stroke-dasharray={node.is_ghost ? "4 2" : "none"}
    class="transition-colors duration-150"
  />

  {#if stateColor}
    <circle cx="15" cy="15" r="3" fill={stateColor} />
  {/if}

  <!-- Kind label -->
  <text
    x={stateColor ? 24 : 12} y="19"
    font-size="11"
    fill="var(--text-muted)"
    font-family="var(--font-mono)"
  >
    {node.is_ghost ? "? " : ""}{kindLabel}
  </text>

  <!-- Name -->
  <text
    x="12" y="35"
    font-size="12"
    fill="var(--text-primary)"
    font-family="var(--font-mono)"
  >
    {displayName}
  </text>
</g>
