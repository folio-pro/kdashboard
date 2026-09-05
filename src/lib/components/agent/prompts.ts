// Quick Action prompt builder — pure, unit-tested.
//
// The prompt orients the Agent (context, namespace, resource) and states the
// task; the MCP tool descriptions carry the "how", so templates stay short.

export interface PromptContext {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}

export type QuickActionId =
  | "analyze-logs"
  | "why-crashing"
  | "optimize-resources"
  | "diagnose-rollout"
  | "ask-about";

export interface QuickActionDef {
  id: QuickActionId;
  label: string;
  /** Plural lowercase resource types this action is curated for; null = all. */
  resourceTypes: string[] | null;
}

/** Curated Quick Actions per resource type + the generic fallback. */
export const QUICK_ACTIONS: QuickActionDef[] = [
  { id: "analyze-logs", label: "Agent: Analyze Logs", resourceTypes: ["pods"] },
  { id: "why-crashing", label: "Agent: Why Is It Crashing?", resourceTypes: ["pods"] },
  { id: "optimize-resources", label: "Agent: Optimize Resources", resourceTypes: ["deployments"] },
  { id: "diagnose-rollout", label: "Agent: Diagnose Rollout", resourceTypes: ["deployments"] },
  { id: "ask-about", label: "Ask Agent About This…", resourceTypes: null },
];

export function quickActionsFor(resourceType: string): QuickActionDef[] {
  return QUICK_ACTIONS.filter((a) => a.resourceTypes === null || a.resourceTypes.includes(resourceType));
}

function orientation(ctx: PromptContext): string {
  const ns = ctx.namespace ? ` in namespace "${ctx.namespace}"` : "";
  return (
    `You are connected to the Kubernetes cluster context "${ctx.context}" through the kdashboard MCP tools ` +
    `(read tools plus a few user-approved mutations — use them for ALL cluster access). ` +
    `The user is looking at the ${ctx.kind} "${ctx.name}"${ns}.`
  );
}

const TASKS: Record<QuickActionId, (ctx: PromptContext) => string> = {
  "analyze-logs": () =>
    `Analyze the logs of this pod (get_pod_logs; check previous=true too if it restarted). ` +
    `Summarize errors and anomalies, and what to do about them.`,
  "why-crashing": () =>
    `This pod is unhealthy. Find out why: check its status and events (list_events), its previous ` +
    `container logs, and its spec. Explain the root cause and propose a concrete fix.`,
  "optimize-resources": () =>
    `Review this deployment's container resource requests/limits against real usage (get_resource + top_pods). ` +
    `Propose concrete values; if I approve, apply them with update_container_resources.`,
  "diagnose-rollout": () =>
    `Diagnose the state of this deployment's rollout: replica status, conditions, events, and pod health. ` +
    `Explain what is blocking it, if anything, and how to fix it.`,
  "ask-about": () => ``,
};

/** Build the full prompt for a Quick Action. */
export function buildQuickActionPrompt(action: QuickActionId, ctx: PromptContext): string {
  const task = TASKS[action](ctx);
  return task.length > 0 ? `${orientation(ctx)} ${task}` : orientation(ctx);
}
