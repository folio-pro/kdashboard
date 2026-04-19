<script lang="ts">
  import type { TopologyNode } from "$lib/types";
  import { KIND_COLORS, KIND_SHORT, STATUS_COLORS, DEFAULT_KIND_COLOR } from "$lib/utils/k8s-colors";

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

  let color = $derived(KIND_COLORS[node.kind] ?? DEFAULT_KIND_COLOR);
  let statusColor = $derived(
    node.status ? (STATUS_COLORS[node.status] ?? "var(--text-muted)") : null
  );
  let displayName = $derived(
    node.name.length > 22 ? node.name.slice(0, 20) + "…" : node.name
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
  <!-- Background rect -->
  <rect
    x="0" y="0"
    {width} {height}
    rx="8"
    fill="var(--bg-secondary)"
    stroke={selected ? "var(--accent)" : node.is_ghost ? "var(--text-muted)" : color}
    stroke-width={selected ? 2 : 1}
    stroke-dasharray={node.is_ghost ? "4 2" : "none"}
    class="transition-all duration-150"
  />

  <!-- Kind color bar (left accent) -->
  <rect
    x="0" y="0"
    width="4" {height}
    rx="2"
    fill={node.is_ghost ? "var(--text-muted)" : color}
    opacity={node.is_ghost ? 0.4 : 0.8}
  />

  <!-- Kind label -->
  <text
    x="14" y="17"
    font-size="9"
    font-weight="600"
    fill={node.is_ghost ? "var(--text-muted)" : color}
    letter-spacing="0.5"
  >
    {node.is_ghost ? "? " : ""}{kindLabel}
  </text>

  <!-- Name -->
  <text
    x="14" y="35"
    font-size="11"
    fill="var(--text-primary)"
    font-family="monospace"
  >
    {displayName}
  </text>

  <!-- Status dot -->
  {#if statusColor}
    <circle
      cx={width - 14}
      cy={height / 2}
      r="4"
      fill={statusColor}
    />
  {/if}
</g>
