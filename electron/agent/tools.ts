// MCP tool surface for Agent Sessions and the external endpoint.
//
// The complete cluster capability an Agent has: the read tools plus the four
// Safe Mutations (see SPEC/CONTEXT.md). Anything not registered here does not
// exist for the agent — restriction by absence, not by policy checks.
//
// Every tool goes through `guarded()`: the endpoint may refuse tool use (a
// session pinned to a kube context the UI has since left) and tool errors
// come back as `isError` text results so the agent can read them and continue
// the conversation.
//
// Cluster work is delegated to the SAME command dispatcher the renderer
// drives, so agent and UI can never disagree on behavior. The one exception
// is get_pod_logs: the dispatcher only streams logs, and the tool needs a
// snapshot, so it reads the API directly.

import { z } from 'zod';

import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';

import { getActiveContextName, getCoreV1Api, kc } from '../k8s/client.js';
import type { HandlerCtx } from '../dispatch.js';
import { requestApproval, type ApprovalSummary } from './approval.js';

export type Dispatch = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AgentToolDeps {
  dispatch: Dispatch;
  ctx: HandlerCtx;
  /**
   * Why tools must not run right now, or null. A session endpoint refuses
   * once the UI leaves the context it was pinned to; the external endpoint
   * never refuses (it follows the active context).
   */
  refusal: () => string | null;
  /** Whether Safe Mutations need Mutation Approval (settings toggle). */
  requireApproval: () => boolean;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// MCP tool annotations (spec hints agent CLIs use to decide whether a call
// needs the user's OK): every read tool is readOnly + idempotent; Safe
// Mutations are writes, and only delete_pod is destructive.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const MUTATION = { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false };

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const errorText = (value: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: value }] });
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

/** Max items a list tool returns — protects the agent's context window. */
const LIST_CAP = 200;

/** Lines fetched before a get_pod_logs grep is applied. */
const LOG_GREP_WINDOW = 5000;

/**
 * Cap a list and tell the agent when it was cut, with the hint that narrows
 * it. Exported for unit tests.
 */
export function capped<T>(items: T[], hint: string, cap = LIST_CAP): { items: T[]; note?: string } {
  if (items.length <= cap) return { items };
  return { items: items.slice(0, cap), note: `truncated: showing ${cap} of ${items.length} — ${hint}` };
}

/**
 * Case-insensitive substring match; `a|b` matches lines containing any term.
 * Deliberately not a regex: the pattern comes from the agent and a
 * backtracking regex on every log line could stall the main process.
 */
export function logMatcher(pattern: string): (line: string) => boolean {
  const terms = pattern
    .split('|')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return () => true;
  return (line) => {
    const lower = line.toLowerCase();
    return terms.some((t) => lower.includes(t));
  };
}

/**
 * Pure guard: the message refusing tool use after a context switch, or null
 * when the pinned context is still active. Exported for unit tests.
 */
export function contextGuardMessage(pinned: string | undefined, current: string | undefined): string | null {
  if (pinned === current) return null;
  return (
    `Kubernetes context changed: this agent session is pinned to context "${pinned ?? '(none)'}" ` +
    `but the active context is now "${current ?? '(none)'}". Tools are disabled for safety; ` +
    `the session will be terminated. Do not retry.`
  );
}

/** Event timestamps arrive as Date objects from the k8s client (strings once serialised). */
function eventMillis(e: { last_timestamp?: unknown; first_timestamp?: unknown }): number {
  const raw = e.last_timestamp ?? e.first_timestamp;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

interface Sample {
  t: number;
  v: number;
}

function summarizeSamples(samples: Sample[]): Record<string, number | null> {
  if (samples.length === 0) return { count: 0, first: null, last: null, min: null, max: null, avg: null };
  const values = samples.map((s) => s.v);
  return {
    count: samples.length,
    first: values[0],
    last: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

/** Every n-th sample so a series never exceeds `max` points. */
export function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = Math.ceil(items.length / max);
  return items.filter((_, i) => i % step === 0);
}

// ---------------------------------------------------------------------------
// Registration helpers — one place for the guard, the error shape and the
// zod → handler typing, so each tool below is just schema + body.
// ---------------------------------------------------------------------------

// The SDK's own shape → args typing, so a handler's parameter is inferred
// from its zod inputSchema and never restated by hand.
type Shape = ZodRawShapeCompat;
type Args<S extends Shape> = ShapeOutput<S>;

interface ToolSpec<S extends Shape> {
  description: string;
  inputSchema: S;
}

function guarded<S extends Shape>(
  deps: AgentToolDeps,
  handler: (args: Args<S>) => Promise<ToolResult> | ToolResult,
): ToolCallback<S> {
  return (async (args: Args<S>) => {
    const refusal = deps.refusal();
    if (refusal) return errorText(refusal);
    try {
      return await handler(args);
    } catch (err) {
      return errorText(err instanceof Error ? err.message : String(err));
    }
    // ToolCallback<S> is conditional on S; TS cannot see through it for a
    // generic S, so the wrapper is asserted once here and nowhere else.
  }) as unknown as ToolCallback<S>;
}

function readTool<S extends Shape>(
  server: McpServer,
  deps: AgentToolDeps,
  name: string,
  spec: ToolSpec<S>,
  handler: (args: Args<S>) => Promise<ToolResult> | ToolResult,
): void {
  server.registerTool(name, { ...spec, annotations: READ_ONLY }, guarded(deps, handler));
}

interface MutationSpec<S extends Shape> extends ToolSpec<S> {
  destructive?: boolean;
  /** What the user sees in the approval dialog. */
  summary: (args: Args<S>) => Omit<ApprovalSummary, 'tool' | 'context'>;
  execute: (args: Args<S>) => Promise<unknown>;
}

/**
 * A Safe Mutation: passes the Mutation Approval gate, then executes. A denial
 * is a normal result the agent can read — never a thrown error.
 */
function mutationTool<S extends Shape>(server: McpServer, deps: AgentToolDeps, name: string, spec: MutationSpec<S>): void {
  const { destructive, summary, execute, ...rest } = spec;
  const description = `Safe Mutation: ${rest.description} The user must approve unless they disabled approval in settings.`;
  server.registerTool(
    name,
    { ...rest, description, annotations: destructive ? DESTRUCTIVE : MUTATION },
    guarded(deps, async (args) => {
      const change = summary(args).changes.join('; ');
      // The context the user reviews is the only one the change may hit: the
      // external endpoint follows the active context, and it can move while
      // the approval dialog is open.
      const context = getActiveContextName();
      if (deps.requireApproval()) {
        const approved = await requestApproval({ ...summary(args), tool: name, context }, deps.ctx);
        if (!approved) {
          return text(
            `The user DENIED this ${name} request (${change}). Do not retry the same change; ask the user or propose an alternative.`,
          );
        }
      }
      const now = getActiveContextName();
      if (now !== context) {
        return errorText(
          `Not applied: the change was approved for context "${context ?? '(none)'}" but the active context is now ` +
            `"${now ?? '(none)'}". Ask the user to re-request it.`,
        );
      }
      await execute(args);
      return text(`Done: ${name} — ${change}`);
    }),
  );
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function registerAgentTools(server: McpServer, deps: AgentToolDeps): void {
  const { dispatch } = deps;

  // --- Read tools ----------------------------------------------------------

  readTool(
    server,
    deps,
    'get_current_context',
    {
      description:
        'Where am I? Returns the active Kubernetes context name, the apiserver URL and the list of ' +
        'namespaces visible to the user. Call this first to orient yourself before using other tools.',
      inputSchema: {},
    },
    async () =>
      json({
        context: getActiveContextName() ?? null,
        server: kc().getCurrentCluster()?.server ?? null,
        namespaces: (await dispatch('get_namespaces')) as string[],
      }),
  );

  readTool(
    server,
    deps,
    'list_resources',
    {
      description:
        'List Kubernetes resources of one type. resourceType is plural lowercase (pods, deployments, ' +
        'services, statefulsets, daemonsets, replicasets, configmaps, secrets, ingresses, nodes, ' +
        'namespaces, jobs, cronjobs, hpa, persistentvolumeclaims, ...). Omit namespace for all namespaces. ' +
        `Returns at most ${LIST_CAP} items.`,
      inputSchema: {
        resourceType: z.string().describe('plural lowercase resource type, e.g. "pods"'),
        namespace: z.string().optional().describe('omit for all namespaces'),
      },
    },
    async ({ resourceType, namespace }) => {
      const list = (await dispatch('list_resources', { resourceType, namespace })) as { items: unknown[] };
      return json(capped(list.items, 'narrow by namespace'));
    },
  );

  readTool(
    server,
    deps,
    'get_resource',
    {
      description:
        'Fetch one resource as full YAML (managedFields stripped). Use after list_resources to inspect ' +
        'spec and status in detail.',
      inputSchema: {
        kind: z.string().describe('resource kind, e.g. "Deployment" or "Pod"'),
        name: z.string(),
        namespace: z.string().optional().describe('omit for cluster-scoped kinds'),
      },
    },
    async ({ kind, name, namespace }) =>
      text((await dispatch('get_resource_yaml', { kind, name, namespace: namespace ?? '' })) as string),
  );

  readTool(
    server,
    deps,
    'get_pod_logs',
    {
      description:
        "Read a pod's logs. Set previous=true for the crashed previous container instance " +
        '(essential for CrashLoopBackOff diagnosis). Defaults to the last 200 lines. ' +
        'Use grep (case-insensitive substring; "a|b" = any of) to keep only matching lines — the filter runs ' +
        `server-side in kdashboard over up to ${LOG_GREP_WINDOW} lines, so it is the cheap way to find errors in a chatty pod.`,
      inputSchema: {
        namespace: z.string(),
        pod: z.string(),
        container: z.string().optional().describe('required only for multi-container pods'),
        tailLines: z.number().int().positive().max(2000).optional(),
        previous: z.boolean().optional(),
        sinceSeconds: z.number().int().positive().optional().describe('only lines newer than this many seconds'),
        grep: z.string().optional().describe('case-insensitive substring, "a|b" for any of several'),
      },
    },
    async ({ namespace, pod, container, tailLines, previous, sinceSeconds, grep }) => {
      const wanted = tailLines ?? 200;
      const logs = await getCoreV1Api().readNamespacedPodLog({
        name: pod,
        namespace,
        container,
        // With a filter, read a wider window so the wanted count survives it.
        tailLines: grep ? Math.max(wanted, LOG_GREP_WINDOW) : wanted,
        previous,
        sinceSeconds,
      });
      if (!grep) return text(logs.length > 0 ? logs : '(no log output)');
      const matches = logs.split('\n').filter(logMatcher(grep));
      const kept = matches.slice(-wanted);
      if (kept.length === 0) return text(`(no lines matching ${JSON.stringify(grep)} in the last ${LOG_GREP_WINDOW} lines)`);
      const omitted = matches.length - kept.length;
      return text((omitted > 0 ? `… ${omitted} earlier matching lines omitted\n` : '') + kept.join('\n'));
    },
  );

  readTool(
    server,
    deps,
    'list_events',
    {
      description:
        'List recent Kubernetes events, newest first. Give resourceType+name to filter to one resource ' +
        `(e.g. why a pod is Pending); otherwise returns namespace-wide (or cluster-wide) events. Returns at most ${LIST_CAP}.`,
      inputSchema: {
        namespace: z.string().optional(),
        resourceType: z.string().optional().describe('plural lowercase, e.g. "pods" — requires name'),
        name: z.string().optional(),
      },
    },
    async ({ namespace, resourceType, name }) => {
      const events = (
        resourceType && name
          ? await dispatch('get_resource_events', { resourceType, name, namespace: namespace ?? '' })
          : await dispatch('get_events', { namespace })
      ) as Array<{ last_timestamp?: unknown; first_timestamp?: unknown }>;
      const newestFirst = [...events].sort((a, b) => eventMillis(b) - eventMillis(a));
      const { items, note } = capped(newestFirst, 'narrow by namespace or resource');
      return json({ events: items, ...(note ? { note } : {}) });
    },
  );

  readTool(
    server,
    deps,
    'top_pods',
    {
      description:
        'Live CPU/memory usage per pod and container (from metrics-server). Compare against requests/limits ' +
        'from get_resource when optimizing workload resources.',
      inputSchema: { namespace: z.string().optional() },
    },
    async ({ namespace }) => {
      const metrics = (await dispatch('get_pod_metrics', { namespace })) as { pods?: unknown[] };
      const { items, note } = capped(metrics.pods ?? [], 'narrow by namespace');
      return json({ ...metrics, pods: items, ...(note ? { note } : {}) });
    },
  );

  readTool(
    server,
    deps,
    'top_nodes',
    { description: 'Live CPU/memory usage and capacity per node.', inputSchema: {} },
    async () => json(await dispatch('get_node_metrics')),
  );

  readTool(
    server,
    deps,
    'list_problems',
    {
      description:
        "kdashboard's own health scan — the same judgement as its Problems view: every workload, pod, node, " +
        'PVC and Service currently in trouble (with reason, cause, owner, restarts, ready/desired), plus the ' +
        'last hour of Warning events and the top pods by CPU/memory. Call this first for "is anything wrong?" ' +
        'questions; then drill in with get_resource / get_pod_logs / list_events.',
      inputSchema: { namespace: z.string().optional().describe('omit for the whole cluster') },
    },
    async ({ namespace }) => {
      const overview = (await dispatch('get_cluster_overview', { namespace: namespace ?? null })) as {
        problems: unknown[];
        warnings: unknown[];
        warnings_total: number;
        nodes: unknown[];
        pods: unknown;
        top_pods_cpu: unknown[];
        top_pods_memory: unknown[];
        metrics_available: boolean;
        partial: string[];
      };
      const problems = capped(overview.problems, 'narrow by namespace');
      return json({
        scope: namespace ?? 'cluster',
        problems: problems.items,
        problems_total: overview.problems.length,
        ...(problems.note ? { note: problems.note } : {}),
        warning_events: overview.warnings.slice(0, 50),
        warning_events_total: overview.warnings_total,
        pods: overview.pods,
        nodes: overview.nodes,
        top_pods_cpu: overview.top_pods_cpu,
        top_pods_memory: overview.top_pods_memory,
        metrics_available: overview.metrics_available,
        ...(overview.partial.length > 0 ? { could_not_list: overview.partial } : {}),
      });
    },
  );

  readTool(
    server,
    deps,
    'get_rightsizing',
    {
      description:
        'Requests vs observed usage per workload and container, with a recommended request and a verdict ' +
        '(over/under-provisioned) and the estimated monthly saving. Usage is P95 over 7 days from Prometheus ' +
        'when configured, otherwise a metrics-server snapshot. Pair with update_container_resources to apply.',
      inputSchema: { namespace: z.string().optional().describe('omit for the whole cluster') },
    },
    async ({ namespace }) => {
      const result = (await dispatch('get_rightsizing', { namespace: namespace ?? null })) as { workloads: unknown[] };
      const { items, note } = capped(result.workloads ?? [], 'narrow by namespace');
      return json({ ...result, workloads: items, ...(note ? { note } : {}) });
    },
  );

  readTool(
    server,
    deps,
    'query_prometheus',
    {
      description:
        'Run a PromQL range query against the Prometheus the user configured in kdashboard (Settings → ' +
        'Kubernetes). Returns series with (unix seconds, value) samples over the last `minutes` (default 60). ' +
        'Fails with a clear message when no Prometheus is configured — do not retry then.',
      inputSchema: {
        query: z.string().describe('PromQL, e.g. rate(container_cpu_usage_seconds_total{namespace="x"}[5m])'),
        minutes: z.number().int().positive().max(7 * 24 * 60).optional(),
      },
    },
    async ({ query, minutes }) => {
      const result = (await dispatch('query_prometheus_range', { query, minutes })) as {
        configured: boolean;
        series: Array<{ labels: Record<string, string>; samples: Sample[] }>;
      };
      if (!result.configured) {
        return errorText('No Prometheus is configured in kdashboard (Settings → Kubernetes → Prometheus URL).');
      }
      const { items, note } = capped(result.series, 'narrow the query', 50);
      return json({
        // Keep the payload small: first/last/min/max/avg plus a thinned sample list per series.
        series: items.map((s) => ({ labels: s.labels, summary: summarizeSamples(s.samples), samples: thin(s.samples, 30) })),
        ...(note ? { note } : {}),
      });
    },
  );

  // --- Safe Mutations — each one passes the Mutation Approval gate ----------

  mutationTool(server, deps, 'scale_workload', {
    description: 'scale a Deployment, StatefulSet or ReplicaSet to a replica count.',
    inputSchema: {
      kind: z.enum(['Deployment', 'StatefulSet', 'ReplicaSet']),
      namespace: z.string(),
      name: z.string(),
      replicas: z.number().int().min(0),
    },
    summary: ({ kind, namespace, name, replicas }) => ({
      resource: { kind, namespace, name },
      changes: [`replicas → ${replicas}`],
    }),
    execute: (args) => dispatch('scale_workload', args),
  });

  mutationTool(server, deps, 'restart_rollout', {
    description: 'rolling restart of a Deployment, StatefulSet or DaemonSet (kubectl rollout restart).',
    inputSchema: {
      kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet']),
      namespace: z.string(),
      name: z.string(),
    },
    summary: ({ kind, namespace, name }) => ({ resource: { kind, namespace, name }, changes: ['rolling restart'] }),
    execute: (args) => dispatch('restart_workload', args),
  });

  mutationTool(server, deps, 'delete_pod', {
    description: 'delete ONE pod (its controller will recreate it). Cannot delete anything else.',
    destructive: true,
    inputSchema: { namespace: z.string(), name: z.string() },
    summary: ({ namespace, name }) => ({ resource: { kind: 'Pod', namespace, name }, changes: ['delete pod'] }),
    execute: ({ namespace, name }) => dispatch('delete_resource', { kind: 'Pod', namespace, name }),
  });

  mutationTool(server, deps, 'update_container_resources', {
    description:
      "set one container's CPU/memory requests and/or limits on a Deployment, StatefulSet, DaemonSet or " +
      'ReplicaSet. Quantities are Kubernetes strings ("250m", "128Mi").',
    inputSchema: {
      kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']),
      namespace: z.string(),
      name: z.string(),
      container: z.string(),
      requests: z.record(z.string(), z.string()).optional().describe('e.g. {"cpu":"250m","memory":"128Mi"}'),
      limits: z.record(z.string(), z.string()).optional(),
    },
    summary: ({ kind, namespace, name, container, requests, limits }) => ({
      resource: { kind, namespace, name, container },
      changes: [
        ...(requests ? [`requests → ${JSON.stringify(requests)}`] : []),
        ...(limits ? [`limits → ${JSON.stringify(limits)}`] : []),
      ],
    }),
    execute: (args) => dispatch('update_container_resources', args),
  });
}
