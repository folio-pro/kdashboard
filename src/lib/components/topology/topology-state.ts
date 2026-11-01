import type { TopologyEdge, TopologyNode } from "$lib/types";
import { isQuietStatus, statusCategory, statusColor } from "$lib/components/table/status-category";

/**
 * The colour a node's status earns, or null when there is nothing to say: the
 * same vocabulary as the resource tables, so a CrashLoopBackOff reads as a
 * failure here too and not as an unknown word.
 */
export function nodeStateColor(node: Pick<TopologyNode, "status">): string | null {
  if (!node.status) return null;
  const category = statusCategory(node.status);
  return isQuietStatus(category) ? null : statusColor(category);
}

/** An edge leading into a node that needs a look takes that node's colour, so
 *  the path down to a failing pod can be followed by eye. */
export function edgeStateColors(nodes: readonly TopologyNode[], edges: readonly TopologyEdge[]): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const colors = new Map<string, string>();
  for (const e of edges) {
    const target = byId.get(e.to);
    const color = target ? nodeStateColor(target) : null;
    if (color) colors.set(`${e.from}-${e.to}`, color);
  }
  return colors;
}
