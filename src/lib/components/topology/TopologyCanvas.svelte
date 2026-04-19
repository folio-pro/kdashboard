<script lang="ts">
  import type { TopologyGraph, TopologyNode, TopologyEdge } from "$lib/types";
  import TopologyNodeElement from "./TopologyNodeElement.svelte";
  import { topologyStore } from "$lib/stores/topology.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { kindToResourceType } from "$lib/utils/related-resources";
  import { toastStore } from "$lib/stores/toast.svelte";

  interface Props {
    graph: TopologyGraph;
  }

  let { graph }: Props = $props();

  // Layout constants
  const NODE_WIDTH = 180;
  const NODE_HEIGHT = 48;
  const LAYER_GAP_Y = 100;
  const NODE_GAP_X = 40;
  const PADDING = 60;

  // Pan & zoom state
  let viewBox = $state({ x: 0, y: 0, w: 1200, h: 800 });
  let isPanning = $state(false);
  let panStart = $state({ x: 0, y: 0 });
  let svgEl: SVGSVGElement | undefined = $state();

  // Hover state
  let hoveredNodeId = $state<string | null>(null);

  // Compute layout: group by depth, position in layers
  let layout = $derived.by(() => {
    const nodes = graph.nodes;
    const edges = graph.edges;

    // Group nodes by depth
    const layers: Map<number, TopologyNode[]> = new Map();
    for (const node of nodes) {
      const depth = node.depth;
      if (!layers.has(depth)) layers.set(depth, []);
      layers.get(depth)!.push(node);
    }

    // Sort layers by depth
    const sortedDepths = Array.from(layers.keys()).sort((a, b) => a - b);

    // Position nodes
    const positions: Map<string, { x: number; y: number }> = new Map();
    let maxWidth = 0;

    for (const depth of sortedDepths) {
      const layerNodes = layers.get(depth)!;
      // Sort nodes within layer by kind then name for consistency
      layerNodes.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
        return a.name.localeCompare(b.name);
      });

      const layerWidth = layerNodes.length * (NODE_WIDTH + NODE_GAP_X) - NODE_GAP_X;
      maxWidth = Math.max(maxWidth, layerWidth);
      const startX = PADDING;

      for (let i = 0; i < layerNodes.length; i++) {
        positions.set(layerNodes[i].id, {
          x: startX + i * (NODE_WIDTH + NODE_GAP_X),
          y: PADDING + depth * (NODE_HEIGHT + LAYER_GAP_Y),
        });
      }
    }

    // Center each layer relative to the widest
    for (const depth of sortedDepths) {
      const layerNodes = layers.get(depth)!;
      const layerWidth = layerNodes.length * (NODE_WIDTH + NODE_GAP_X) - NODE_GAP_X;
      const offset = (maxWidth - layerWidth) / 2;
      for (const node of layerNodes) {
        const pos = positions.get(node.id)!;
        pos.x += offset;
      }
    }

    // Compute viewBox to fit all content
    const totalWidth = maxWidth + PADDING * 2;
    const totalHeight = (sortedDepths.length) * (NODE_HEIGHT + LAYER_GAP_Y) + PADDING * 2;

    return { positions, totalWidth, totalHeight };
  });

  // Set initial viewbox when layout changes
  $effect(() => {
    if (layout) {
      viewBox = { x: 0, y: 0, w: layout.totalWidth, h: layout.totalHeight };
    }
  });

  // Edge paths with connected node highlighting
  let connectedIds = $derived.by(() => {
    const ids = new Set<string>();
    if (!hoveredNodeId) return ids;
    ids.add(hoveredNodeId);
    for (const e of graph.edges) {
      if (e.from === hoveredNodeId || e.to === hoveredNodeId) {
        ids.add(e.from);
        ids.add(e.to);
      }
    }
    return ids;
  });

  function edgePath(edge: TopologyEdge): string {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to) return "";

    const x1 = from.x + NODE_WIDTH / 2;
    const y1 = from.y + NODE_HEIGHT;
    const x2 = to.x + NODE_WIDTH / 2;
    const y2 = to.y;
    const cy1 = y1 + (y2 - y1) * 0.4;
    const cy2 = y1 + (y2 - y1) * 0.6;

    return `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
  }

  function isEdgeHighlighted(edge: TopologyEdge): boolean {
    if (!hoveredNodeId) return false;
    return edge.from === hoveredNodeId || edge.to === hoveredNodeId;
  }

  function isEdgeDimmed(edge: TopologyEdge): boolean {
    if (!hoveredNodeId) return false;
    return !isEdgeHighlighted(edge);
  }

  // Pan handlers
  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isPanning || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    const dx = (e.clientX - panStart.x) * scaleX;
    const dy = (e.clientY - panStart.y) * scaleY;
    viewBox = { ...viewBox, x: viewBox.x - dx, y: viewBox.y - dy };
    panStart = { x: e.clientX, y: e.clientY };
  }

  function handleMouseUp() {
    isPanning = false;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!svgEl) return;

    const rect = svgEl.getBoundingClientRect();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;

    // Mouse position in SVG coords
    const mx = viewBox.x + ((e.clientX - rect.left) / rect.width) * viewBox.w;
    const my = viewBox.y + ((e.clientY - rect.top) / rect.height) * viewBox.h;

    const newW = viewBox.w * factor;
    const newH = viewBox.h * factor;
    const newX = mx - (mx - viewBox.x) * factor;
    const newY = my - (my - viewBox.y) * factor;

    viewBox = { x: newX, y: newY, w: newW, h: newH };
  }

  // Node click → navigate to resource
  function handleNodeClick(node: TopologyNode) {
    if (node.is_ghost) {
      toastStore.warning("Ghost node", `"${node.name}" (${node.kind}) was not found in the cluster`);
      return;
    }
    topologyStore.selectNode(node.id);
    const resourceType = kindToResourceType(node.kind);
    openRelatedResourceTab(resourceType, node.name, node.namespace);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg
  bind:this={svgEl}
  class="h-full w-full"
  viewBox="{viewBox.x} {viewBox.y} {viewBox.w} {viewBox.h}"
  style="cursor: {isPanning ? 'grabbing' : 'grab'};"
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={handleMouseUp}
  onwheel={handleWheel}
>
  <!-- Arrow marker -->
  <defs>
    <marker
      id="arrowhead"
      markerWidth="8"
      markerHeight="6"
      refX="8"
      refY="3"
      orient="auto"
    >
      <polygon points="0 0, 8 3, 0 6" fill="var(--text-muted)" opacity="0.5" />
    </marker>
    <marker
      id="arrowhead-highlight"
      markerWidth="8"
      markerHeight="6"
      refX="8"
      refY="3"
      orient="auto"
    >
      <polygon points="0 0, 8 3, 0 6" fill="var(--accent)" opacity="0.8" />
    </marker>
  </defs>

  <!-- Edges -->
  {#each graph.edges as edge (edge.from + "-" + edge.to)}
    <path
      d={edgePath(edge)}
      fill="none"
      stroke={isEdgeHighlighted(edge) ? "var(--accent)" : "var(--text-muted)"}
      stroke-width={isEdgeHighlighted(edge) ? 2 : 1}
      stroke-opacity={isEdgeDimmed(edge) ? 0.15 : isEdgeHighlighted(edge) ? 0.8 : 0.35}
      marker-end={isEdgeHighlighted(edge) ? "url(#arrowhead-highlight)" : "url(#arrowhead)"}
      class="transition-all duration-150"
    />
  {/each}

  <!-- Cluster group badges -->
  {#each graph.cluster_groups as group}
    {@const pos = layout.positions.get(group.controller_id)}
    {#if pos}
      <g transform="translate({pos.x + NODE_WIDTH + 8}, {pos.y + NODE_HEIGHT / 2 - 10})">
        <rect
          x="0" y="0" width="64" height="20" rx="10"
          fill="var(--bg-tertiary)"
          stroke="var(--border-color)"
          stroke-width="1"
        />
        <text
          x="32" y="14"
          text-anchor="middle"
          font-size="10"
          fill="var(--text-secondary)"
        >
          +{group.pod_count} pods
        </text>
      </g>
    {/if}
  {/each}

  <!-- Nodes -->
  {#each graph.nodes as node (node.id)}
    {@const pos = layout.positions.get(node.id)}
    {#if pos}
      <TopologyNodeElement
        {node}
        x={pos.x}
        y={pos.y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        selected={topologyStore.selectedNodeId === node.id}
        dimmed={hoveredNodeId !== null && !connectedIds.has(node.id)}
        onmouseenter={() => hoveredNodeId = node.id}
        onmouseleave={() => hoveredNodeId = null}
        onclick={() => handleNodeClick(node)}
      />
    {/if}
  {/each}
</svg>
