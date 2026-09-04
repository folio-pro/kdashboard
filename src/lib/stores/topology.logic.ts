import { AsyncLoadStoreLogic } from "./async-load.logic";
import type { TopologyGraph, TopologyNode } from "$lib/types";

export class TopologyStoreLogic extends AsyncLoadStoreLogic<TopologyGraph> {
  /** Alias for readability in templates */
  get graph() { return this.data; }

  selectedNodeId: string | null = null;
  expandedClusters: Set<string> = new Set();
  focusedResourceUid: string | null = null;

  selectNode(id: string | null): void {
    this.selectedNodeId = id;
  }

  toggleClusterExpansion(controllerId: string): void {
    const next = new Set(this.expandedClusters);
    if (next.has(controllerId)) {
      next.delete(controllerId);
    } else {
      next.add(controllerId);
    }
    this.expandedClusters = next;
  }

  override reset(): void {
    super.reset();
    this.selectedNodeId = null;
    this.expandedClusters = new Set();
    this.focusedResourceUid = null;
  }
}

// ---------------------------------------------------------------------------
// Layout and viewport fitting — pure geometry for TopologyCanvas.
//
// A namespace with 48 pods used to lay every pod out in one 10,000px-wide row
// and then fit that row to the viewport, which rendered the graph as a strip
// of 18px boxes. Layers now wrap into rows sized so that, at the minimum
// readable zoom, a row spans the viewport; fitting then trades width for
// height (which pans) rather than for legibility.
// ---------------------------------------------------------------------------

export interface LayoutMetrics {
  nodeWidth: number;
  nodeHeight: number;
  /** Vertical gap between depth layers (room for the ownership edges). */
  layerGapY: number;
  /** Vertical gap between wrapped rows inside one layer. */
  rowGapY: number;
  gapX: number;
  padding: number;
}

export const TOPOLOGY_METRICS: LayoutMetrics = {
  nodeWidth: 180,
  nodeHeight: 48,
  layerGapY: 100,
  rowGapY: 28,
  gapX: 40,
  padding: 60,
};

/** Zoom below which node labels (9–11px) stop being readable. */
export const MIN_FIT_SCALE = 0.75;
/** A three-node graph does not need to be blown up to fill the screen. */
export const MAX_FIT_SCALE = 1.25;

export interface Point { x: number; y: number }

export interface TopologyLayout {
  positions: Map<string, Point>;
  /** Content extent, padding included. */
  width: number;
  height: number;
}

export interface ViewBox { x: number; y: number; w: number; h: number }

/**
 * How many nodes fit in one row when the viewport is shown at `minScale`.
 * Wrapping at this count is what keeps a fitted graph readable: no layer is
 * ever wider than the viewport at the minimum zoom.
 */
export function maxNodesPerRow(viewportWidth: number, minScale = MIN_FIT_SCALE, m: LayoutMetrics = TOPOLOGY_METRICS): number {
  if (!(viewportWidth > 0)) return 6;
  const usable = viewportWidth / minScale - m.padding * 2 + m.gapX;
  return Math.max(1, Math.floor(usable / (m.nodeWidth + m.gapX)));
}

/**
 * Group nodes by depth, sort each layer by kind then name, wrap layers into
 * rows of at most `maxPerRow`, centre every row on the widest, and stack the
 * layers top to bottom.
 */
export function layoutTopology(
  nodes: readonly TopologyNode[],
  maxPerRow: number,
  m: LayoutMetrics = TOPOLOGY_METRICS,
): TopologyLayout {
  const perRow = Math.max(1, Math.floor(maxPerRow));
  const layers = new Map<number, TopologyNode[]>();
  for (const node of nodes) {
    const layer = layers.get(node.depth);
    if (layer) layer.push(node);
    else layers.set(node.depth, [node]);
  }
  const depths = [...layers.keys()].sort((a, b) => a - b);

  const rows: { nodes: TopologyNode[]; y: number }[] = [];
  let y = m.padding;
  let maxRowWidth = 0;
  for (const depth of depths) {
    const layer = layers.get(depth)!;
    layer.sort((a, b) => (a.kind !== b.kind ? a.kind.localeCompare(b.kind) : a.name.localeCompare(b.name)));
    for (let i = 0; i < layer.length; i += perRow) {
      const chunk = layer.slice(i, i + perRow);
      rows.push({ nodes: chunk, y });
      maxRowWidth = Math.max(maxRowWidth, rowWidth(chunk.length, m));
      y += m.nodeHeight + m.rowGapY;
    }
    // Replace the last row gap of the layer with the layer gap.
    y += m.layerGapY - m.rowGapY;
  }

  const positions = new Map<string, Point>();
  for (const row of rows) {
    const offset = (maxRowWidth - rowWidth(row.nodes.length, m)) / 2;
    row.nodes.forEach((node, i) => {
      positions.set(node.id, { x: m.padding + offset + i * (m.nodeWidth + m.gapX), y: row.y });
    });
  }

  const height = rows.length === 0 ? m.padding * 2 : y - m.layerGapY + m.padding;
  return { positions, width: maxRowWidth + m.padding * 2, height };
}

function rowWidth(count: number, m: LayoutMetrics): number {
  return count <= 0 ? 0 : count * (m.nodeWidth + m.gapX) - m.gapX;
}

/**
 * The viewBox that shows `content` inside `viewport` at the largest zoom in
 * [minScale, maxScale] that fits — or, when fitting would drop below
 * minScale, at minScale from the top with the content centred horizontally,
 * so the user pans down through a readable graph instead of squinting at a
 * complete one. The box keeps the viewport's aspect ratio so SVG's default
 * `meet` scaling maps it 1:1.
 */
export function fitViewBox(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  minScale = MIN_FIT_SCALE,
  maxScale = MAX_FIT_SCALE,
): ViewBox {
  const vw = viewport.width > 0 ? viewport.width : 1200;
  const vh = viewport.height > 0 ? viewport.height : 800;
  const cw = Math.max(1, content.width);
  const ch = Math.max(1, content.height);
  const fit = Math.min(vw / cw, vh / ch);
  const scale = Math.min(maxScale, Math.max(minScale, fit));
  const w = vw / scale;
  const h = vh / scale;
  return {
    x: (cw - w) / 2,
    y: ch <= h ? (ch - h) / 2 : 0,
    w,
    h,
  };
}
