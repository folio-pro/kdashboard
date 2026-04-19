import type { ToolConfig, AnnotationGroup } from "./types";

export const TOOL_REGISTRY: ToolConfig[] = [
  {
    id: "ambassador",
    name: "Ambassador",
    prefixes: ["getambassador.io/"],
    icon: "Globe",

  },
  {
    id: "istio",
    name: "Istio",
    prefixes: ["sidecar.istio.io/", "istio.io/"],
    icon: "Network",

  },
  {
    id: "cert-manager",
    name: "cert-manager",
    prefixes: ["cert-manager.io/", "acme.cert-manager.io/"],
    icon: "ShieldCheck",

  },
  {
    id: "argocd",
    name: "ArgoCD",
    prefixes: ["argocd.argoproj.io/"],
    icon: "GitBranch",

  },
  {
    id: "linkerd",
    name: "Linkerd",
    prefixes: ["linkerd.io/"],
    icon: "Link",

  },
  {
    id: "helm",
    name: "Helm",
    prefixes: ["meta.helm.sh/", "helm.sh/"],
    icon: "Ship",

  },
  {
    id: "kubernetes",
    name: "Kubernetes",
    prefixes: ["kubernetes.io/", "kubectl.kubernetes.io/"],
    icon: "Box",

  },
  {
    id: "prometheus",
    name: "Prometheus",
    prefixes: ["prometheus.io/"],
    icon: "BarChart3",

  },
];

/**
 * Build a flat list of (prefix, toolConfig) pairs sorted by prefix length descending.
 * This ensures longest-prefix-match when iterating.
 */
function buildPrefixIndex(
  registry: ToolConfig[]
): Array<{ prefix: string; tool: ToolConfig }> {
  const pairs: Array<{ prefix: string; tool: ToolConfig }> = [];
  for (const tool of registry) {
    for (const prefix of tool.prefixes) {
      pairs.push({ prefix, tool });
    }
  }
  pairs.sort((a, b) => b.prefix.length - a.prefix.length);
  return pairs;
}

const PREFIX_INDEX = buildPrefixIndex(TOOL_REGISTRY);

export function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function classifyAnnotations(
  annotations: Record<string, string>
): AnnotationGroup[] {
  if (!annotations || Object.keys(annotations).length === 0) return [];

  const toolMap = new Map<
    string | null,
    {
      tool: ToolConfig | null;
      annotations: Record<string, string>;
      shortKeys: Record<string, string>;
    }
  >();

  for (const [key, value] of Object.entries(annotations)) {
    let matched = false;

    for (const { prefix, tool } of PREFIX_INDEX) {
      if (key.startsWith(prefix)) {
        const groupId = tool.id;
        if (!toolMap.has(groupId)) {
          toolMap.set(groupId, {
            tool,
            annotations: {},
            shortKeys: {},
          });
        }
        const group = toolMap.get(groupId)!;
        group.annotations[key] = value;
        group.shortKeys[key] = stripPrefix(key, prefix);
        matched = true;
        break;
      }
    }

    if (!matched) {
      if (!toolMap.has(null)) {
        toolMap.set(null, {
          tool: null,
          annotations: {},
          shortKeys: {},
        });
      }
      const group = toolMap.get(null)!;
      group.annotations[key] = value;
      group.shortKeys[key] = key;
    }
  }

  const groups: AnnotationGroup[] = [];
  const otherGroup = toolMap.get(null);

  // Collect tool groups (non-null)
  const toolGroups: AnnotationGroup[] = [];
  for (const [id, entry] of toolMap.entries()) {
    if (id === null) continue;
    toolGroups.push({
      tool: entry.tool,
      annotations: entry.annotations,
      shortKeys: entry.shortKeys,
    });
  }

  // Sort by count descending, then name alphabetically
  toolGroups.sort((a, b) => {
    const countDiff =
      Object.keys(b.annotations).length - Object.keys(a.annotations).length;
    if (countDiff !== 0) return countDiff;
    return (a.tool?.name ?? "").localeCompare(b.tool?.name ?? "");
  });

  groups.push(...toolGroups);

  // "Other" group always last
  if (otherGroup && Object.keys(otherGroup.annotations).length > 0) {
    groups.push({
      tool: null,
      annotations: otherGroup.annotations,
      shortKeys: otherGroup.shortKeys,
    });
  }

  return groups;
}
