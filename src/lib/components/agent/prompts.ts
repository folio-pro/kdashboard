// Quick Action prompt builders — pure, unit-tested.
//
// The prompt orients the Agent (context, namespace, resource) and states the
// task; the MCP tool descriptions carry the "how", so templates stay short.
// Three entry points feed the same Agent Session:
//   - Quick Actions on a selected resource (context menu / row actions),
//   - Presets from the panel header (cluster-wide questions),
//   - contextual "investigate" buttons (Problems view, alerts, log viewer).

import type { Problem, WatchedResource } from "$lib/types";
import type { Alert } from "$lib/stores/alerts.logic";

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
  | "why-failed"
  | "diagnose-node"
  | "check-connectivity"
  | "why-pending"
  | "why-not-scaling"
  | "explain"
  | "ask-about";

export interface QuickActionDef {
  id: QuickActionId;
  label: string;
  /** Plural lowercase resource types this action is curated for; null = all. */
  resourceTypes: string[] | null;
}

const WORKLOADS = ["deployments", "statefulsets", "daemonsets"];

/** Curated Quick Actions per resource type + the generic fallbacks. */
export const QUICK_ACTIONS: QuickActionDef[] = [
  { id: "analyze-logs", label: "Agent: Analyze Logs", resourceTypes: ["pods"] },
  { id: "why-crashing", label: "Agent: Why Is It Crashing?", resourceTypes: ["pods"] },
  { id: "optimize-resources", label: "Agent: Optimize Resources", resourceTypes: WORKLOADS },
  { id: "diagnose-rollout", label: "Agent: Diagnose Rollout", resourceTypes: [...WORKLOADS, "replicasets"] },
  { id: "why-failed", label: "Agent: Why Did It Fail?", resourceTypes: ["jobs", "cronjobs"] },
  { id: "diagnose-node", label: "Agent: Diagnose Node", resourceTypes: ["nodes"] },
  {
    id: "check-connectivity",
    label: "Agent: Check Connectivity",
    resourceTypes: ["services", "ingresses", "endpoints", "endpointslices", "networkpolicies"],
  },
  { id: "why-pending", label: "Agent: Why Is It Pending?", resourceTypes: ["persistentvolumeclaims"] },
  { id: "why-not-scaling", label: "Agent: Why Isn't It Scaling?", resourceTypes: ["hpa", "vpa", "wpa"] },
  { id: "explain", label: "Agent: Explain This Resource", resourceTypes: null },
  { id: "ask-about", label: "Ask Agent About This…", resourceTypes: null },
];

export function quickActionApplies(action: QuickActionDef, resourceType: string): boolean {
  return action.resourceTypes === null || action.resourceTypes.includes(resourceType);
}

export function quickActionsFor(resourceType: string): QuickActionDef[] {
  return QUICK_ACTIONS.filter((a) => quickActionApplies(a, resourceType));
}

const TOOLS_HINT =
  `through the kdashboard MCP tools (read tools plus a few user-approved mutations — use them for ALL cluster access)`;

function orientation(ctx: PromptContext): string {
  const ns = ctx.namespace ? ` in namespace "${ctx.namespace}"` : "";
  return (
    `You are connected to the Kubernetes cluster context "${ctx.context}" ${TOOLS_HINT}. ` +
    `The user is looking at the ${ctx.kind} "${ctx.name}"${ns}.`
  );
}

const TASKS: Record<QuickActionId, (ctx: PromptContext) => string> = {
  "analyze-logs": () =>
    `Analyze the logs of this pod (get_pod_logs; check previous=true too if it restarted, and use grep to zoom in on errors). ` +
    `Summarize errors and anomalies, and what to do about them.`,
  "why-crashing": () =>
    `This pod is unhealthy. Find out why: check its status and events (list_events), its previous ` +
    `container logs, and its spec. Explain the root cause and propose a concrete fix.`,
  "optimize-resources": (ctx) =>
    `Review this ${ctx.kind.toLowerCase()}'s container resource requests/limits against real usage ` +
    `(get_rightsizing for the recommendation, get_resource + top_pods for detail). ` +
    `Propose concrete values; if I approve, apply them with update_container_resources.`,
  "diagnose-rollout": (ctx) =>
    `Diagnose the state of this ${ctx.kind.toLowerCase()}'s rollout: replica status, conditions, events, and pod health. ` +
    `Explain what is blocking it, if anything, and how to fix it.`,
  "why-failed": (ctx) =>
    `This ${ctx.kind.toLowerCase()} is failing or not completing. Check its status and conditions, its events, ` +
    `and the logs of its most recent pod(s) (list_resources pods with the job's labels, get_pod_logs). ` +
    `Explain the root cause and propose a fix.`,
  "diagnose-node": () =>
    `Diagnose this node: conditions (pressure, ready), taints, allocatable vs requested resources, live usage (top_nodes), ` +
    `recent events, and which pods on it are unhealthy. Say whether the node itself is the problem and what to do.`,
  "check-connectivity": (ctx) =>
    `Check whether traffic can reach this ${ctx.kind}: selector vs pod labels, endpoints/endpointslices readiness, ` +
    `ports and targetPorts, ingress backends and classes, and NetworkPolicies that may block it. ` +
    `Explain any gap and how to fix it.`,
  "why-pending": () =>
    `This PersistentVolumeClaim is not bound. Check its spec (storageClass, access modes, size), the StorageClass and ` +
    `provisioner, matching PersistentVolumes, and its events. Explain why it is stuck and how to fix it.`,
  "why-not-scaling": () =>
    `Explain why this autoscaler is not behaving as expected: its target, current vs desired replicas, metrics ` +
    `availability (top_pods / query_prometheus), conditions and events. Recommend concrete changes.`,
  explain: (ctx) =>
    `Explain this ${ctx.kind} to me: fetch it with get_resource and walk through what each important part of its spec ` +
    `and status means, what it does in this cluster, and anything unusual or risky in its configuration.`,
  "ask-about": () => ``,
};

/** Build the full prompt for a Quick Action. */
export function buildQuickActionPrompt(action: QuickActionId, ctx: PromptContext): string {
  const task = TASKS[action](ctx);
  return task.length > 0 ? `${orientation(ctx)} ${task}` : orientation(ctx);
}

// ---------------------------------------------------------------------------
// Presets — cluster-wide questions from the panel header
// ---------------------------------------------------------------------------

export interface PresetContext {
  context: string;
  /** The namespace the UI is scoped to; undefined = whole cluster. */
  namespace?: string;
}

export type PresetId = "cluster-health" | "namespace-health" | "rightsizing-review" | "warning-events" | "capacity";

export interface PresetDef {
  id: PresetId;
  label: string;
  /** Hidden when the UI is not scoped to a namespace. */
  needsNamespace?: boolean;
}

export const PRESETS: PresetDef[] = [
  { id: "cluster-health", label: "Cluster health check" },
  { id: "namespace-health", label: "Namespace health check", needsNamespace: true },
  { id: "warning-events", label: "Review warning events" },
  { id: "rightsizing-review", label: "Rightsizing review" },
  { id: "capacity", label: "Node capacity & pressure" },
];

function presetOrientation(ctx: PresetContext): string {
  return `You are connected to the Kubernetes cluster context "${ctx.context}" ${TOOLS_HINT}.`;
}

const PRESET_TASKS: Record<PresetId, (ctx: PresetContext) => string> = {
  "cluster-health": () =>
    `Is anything wrong with this cluster? Start with list_problems (whole cluster), then investigate the most severe ` +
    `problems with get_resource / list_events / get_pod_logs. Give me a prioritized summary with a concrete fix per problem.`,
  "namespace-health": (ctx) =>
    `Is anything wrong in namespace "${ctx.namespace}"? Start with list_problems for that namespace, then investigate ` +
    `each problem with get_resource / list_events / get_pod_logs. Give me a prioritized summary with a concrete fix per problem.`,
  "warning-events": (ctx) =>
    `Review the recent Warning events${ctx.namespace ? ` in namespace "${ctx.namespace}"` : ` across the cluster`} ` +
    `(list_events). Group them by root cause, tell me which ones matter, and what to do about each.`,
  "rightsizing-review": (ctx) =>
    `Review resource requests vs real usage${ctx.namespace ? ` in namespace "${ctx.namespace}"` : ` across the cluster`} ` +
    `with get_rightsizing. List the most over- and under-provisioned workloads with recommended values and the estimated ` +
    `saving; for any I approve, apply them with update_container_resources.`,
  capacity: () =>
    `Assess node capacity: top_nodes and list_resources nodes for allocatable vs requested CPU/memory, pressure conditions, ` +
    `taints, and unschedulable pods (list_problems). Tell me whether the cluster is close to its limits and what to do.`,
};

export function buildPresetPrompt(preset: PresetId, ctx: PresetContext): string {
  return `${presetOrientation(ctx)} ${PRESET_TASKS[preset](ctx)}`;
}

// ---------------------------------------------------------------------------
// Contextual entry points — Problems view, alerts, log viewer
// ---------------------------------------------------------------------------

type ProblemLike = Pick<Problem, "kind" | "name" | "namespace" | "reason"> &
  Partial<Pick<Problem, "detail" | "owner" | "restarts">>;

/** "Investigate with agent" on one Problem: reason and detail travel along. */
export function buildProblemPrompt(ctx: PresetContext, problem: ProblemLike): string {
  const where = problem.namespace ? ` in namespace "${problem.namespace}"` : "";
  const detail = problem.detail ? ` (${problem.detail})` : "";
  const owner = problem.owner ? `, owned by ${problem.owner}` : "";
  const restarts = problem.restarts ? `, ${problem.restarts} restarts` : "";
  return (
    `${presetOrientation(ctx)} kdashboard flagged the ${problem.kind} "${problem.name}"${where}${owner} as a problem: ` +
    `${problem.reason}${detail}${restarts}. Investigate it (get_resource, list_events, get_pod_logs with previous=true ` +
    `if it restarted), explain the root cause and propose a concrete fix.`
  );
}

/** "Investigate all" on the Problems view. */
export function buildProblemsSweepPrompt(ctx: PresetContext, count: number): string {
  const scope = ctx.namespace ? `namespace "${ctx.namespace}"` : "the whole cluster";
  return (
    `${presetOrientation(ctx)} kdashboard currently flags ${count} problem${count === 1 ? "" : "s"} in ${scope}. ` +
    `Fetch them with list_problems, investigate each (most severe first) and give me a prioritized report with a root ` +
    `cause and a concrete fix per problem.`
  );
}

/** "Investigate" on a recent alert from a watched resource. */
export function buildAlertPrompt(
  ctx: PresetContext,
  watched: Pick<WatchedResource, "kind" | "name" | "namespace">,
  alert: Pick<Alert, "title" | "body">,
): string {
  const where = watched.namespace ? ` in namespace "${watched.namespace}"` : "";
  return (
    `${presetOrientation(ctx)} kdashboard raised an alert on the watched ${watched.kind} "${watched.name}"${where}: ` +
    `"${alert.title}" — ${alert.body}. Investigate what happened (get_resource, list_events, get_pod_logs), whether it ` +
    `is still ongoing, and what to do about it.`
  );
}

export interface LogsPromptInput {
  namespace: string;
  /** The pod being streamed, or the deployment whose pods are aggregated. */
  kind: string;
  name: string;
  /** For a workload view narrowed to one of its pods. */
  pod?: string;
  container?: string;
  filterText?: string;
  useRegex?: boolean;
  level?: string;
  previous?: boolean;
}

/** "Ask agent" from the log viewer: carries the user's current filter so the agent reproduces the view. */
export function buildLogsPrompt(ctx: PresetContext, input: LogsPromptInput): string {
  const container = input.container ? ` (container "${input.container}")` : "";
  const filter = input.filterText
    ? ` The user filtered the lines with ${input.useRegex ? `the regex /${input.filterText}/` : `"${input.filterText}"`}` +
      ` — pass it as the grep argument.`
    : "";
  const level = input.level && input.level !== "all" ? ` Only lines of level "${input.level}" are shown.` : "";
  const previous = input.previous ? ` The viewer shows the PREVIOUS container instance (previous=true).` : "";
  const target =
    input.kind.toLowerCase() === "pod"
      ? `the pod "${input.name}"${container}`
      : input.pod
        ? `the pod "${input.pod}"${container} of the ${input.kind} "${input.name}"`
        : `the pods of the ${input.kind} "${input.name}"${container} (list_resources pods, then get_pod_logs each)`;
  return (
    `${presetOrientation(ctx)} The user is reading the logs of ${target} in namespace "${input.namespace}".` +
    `${filter}${level}${previous} Read those logs with get_pod_logs, explain what is going on — errors, anomalies, ` +
    `repeating patterns — and what to do about it.`
  );
}
