// MCP tool surface for Agent Sessions.
//
// The complete cluster capability an Agent has: seven read tools plus the four
// Safe Mutations (see SPEC/CONTEXT.md). Anything not registered here does not
// exist for the agent — restriction by absence, not by policy checks.
//
// Every tool goes through `guarded()`: the session is pinned to the kube
// context it started on, and tools fail closed (structured error result, not a
// protocol error) the moment the UI switches context. Tool errors likewise
// come back as `isError` text results so the agent can read them and continue
// the conversation.
//
// Cluster work is delegated to the SAME command dispatcher the renderer
// drives, so agent and UI can never disagree on behavior.

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getActiveContextName, getCoreV1Api, kc } from '../k8s/client.js';
import type { HandlerCtx } from '../dispatch.js';
import { requestApproval, type ApprovalSummary } from './approval.js';

export type Dispatch = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AgentToolDeps {
  dispatch: Dispatch;
  ctx: HandlerCtx;
  /** Context name the Agent Session started on; tools refuse to run off it. */
  pinnedContext: string | undefined;
  /** Whether Safe Mutations need Mutation Approval (settings toggle). */
  requireApproval: () => boolean;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * MCP tool annotations (spec hints agent CLIs use to decide whether a call
 * needs the user's OK): every read tool is readOnly + idempotent; Safe
 * Mutations are writes, and only delete_pod is destructive.
 */
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const MUTATION = { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false };

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const errorText = (value: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: value }] });
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

/** Max items a list tool returns — protects the agent's context window. */
const LIST_CAP = 200;

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

type ToolHandler<A> = (args: A) => Promise<ToolResult> | ToolResult;

function guarded<A>(deps: AgentToolDeps, handler: ToolHandler<A>): ToolHandler<A> {
  return async (args: A): Promise<ToolResult> => {
    const refusal = contextGuardMessage(deps.pinnedContext, getActiveContextName());
    if (refusal) return errorText(refusal);
    try {
      return await handler(args);
    } catch (err) {
      return errorText(err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * Run a Safe Mutation through the Mutation Approval gate, then execute.
 * A denial is a normal result the agent can read — never a thrown error.
 */
async function approvedMutation(
  deps: AgentToolDeps,
  summary: ApprovalSummary,
  execute: () => Promise<unknown>,
): Promise<ToolResult> {
  if (deps.requireApproval()) {
    const approved = await requestApproval(summary, deps.ctx);
    if (!approved) {
      return text(
        `The user DENIED this ${summary.tool} request (${summary.changes.join('; ')}). ` +
          'Do not retry the same change; ask the user or propose an alternative.',
      );
    }
  }
  await execute();
  return text(`Done: ${summary.tool} — ${summary.changes.join('; ')}`);
}

export function registerAgentTools(server: McpServer, deps: AgentToolDeps): void {
  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_current_context',
    {
      annotations: READ_ONLY,
      description:
        'Where am I? Returns the active Kubernetes context name, the apiserver URL and the list of ' +
        'namespaces visible to the user. Call this first to orient yourself before using other tools.',
      inputSchema: {},
    },
    guarded(deps, async () => {
      const namespaces = (await deps.dispatch('get_namespaces')) as string[];
      return json({
        context: getActiveContextName() ?? null,
        server: kc().getCurrentCluster()?.server ?? null,
        namespaces,
      });
    }),
  );

  server.registerTool(
    'list_resources',
    {
      annotations: READ_ONLY,
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
    guarded(deps, async ({ resourceType, namespace }: { resourceType: string; namespace?: string }) => {
      const list = (await deps.dispatch('list_resources', { resourceType, namespace })) as {
        items: unknown[];
      };
      const capped = list.items.length > LIST_CAP;
      return json({
        items: list.items.slice(0, LIST_CAP),
        ...(capped
          ? { note: `truncated: showing ${LIST_CAP} of ${list.items.length} items — narrow by namespace` }
          : {}),
      });
    }),
  );

  server.registerTool(
    'get_resource',
    {
      annotations: READ_ONLY,
      description:
        'Fetch one resource as full YAML (managedFields stripped). Use after list_resources to inspect ' +
        'spec and status in detail.',
      inputSchema: {
        kind: z.string().describe('resource kind, e.g. "Deployment" or "Pod"'),
        name: z.string(),
        namespace: z.string().optional().describe('omit for cluster-scoped kinds'),
      },
    },
    guarded(deps, async ({ kind, name, namespace }: { kind: string; name: string; namespace?: string }) => {
      const yaml = (await deps.dispatch('get_resource_yaml', {
        kind,
        name,
        namespace: namespace ?? '',
      })) as string;
      return text(yaml);
    }),
  );

  server.registerTool(
    'get_pod_logs',
    {
      annotations: READ_ONLY,
      description:
        "Read a pod's logs. Set previous=true for the crashed previous container instance " +
        '(essential for CrashLoopBackOff diagnosis). Defaults to the last 200 lines.',
      inputSchema: {
        namespace: z.string(),
        pod: z.string(),
        container: z.string().optional().describe('required only for multi-container pods'),
        tailLines: z.number().int().positive().max(2000).optional(),
        previous: z.boolean().optional(),
      },
    },
    guarded(
      deps,
      async ({
        namespace,
        pod,
        container,
        tailLines,
        previous,
      }: {
        namespace: string;
        pod: string;
        container?: string;
        tailLines?: number;
        previous?: boolean;
      }) => {
        const logs = await getCoreV1Api().readNamespacedPodLog({
          name: pod,
          namespace,
          container,
          tailLines: tailLines ?? 200,
          previous,
        });
        return text(logs.length > 0 ? logs : '(no log output)');
      },
    ),
  );

  server.registerTool(
    'list_events',
    {
      annotations: READ_ONLY,
      description:
        'List recent Kubernetes events. Give resourceType+name to filter to one resource ' +
        '(e.g. why a pod is Pending); otherwise returns namespace-wide (or cluster-wide) events.',
      inputSchema: {
        namespace: z.string().optional(),
        resourceType: z.string().optional().describe('plural lowercase, e.g. "pods" — requires name'),
        name: z.string().optional(),
      },
    },
    guarded(
      deps,
      async ({ namespace, resourceType, name }: { namespace?: string; resourceType?: string; name?: string }) => {
        const events =
          resourceType && name
            ? await deps.dispatch('get_resource_events', { resourceType, name, namespace: namespace ?? '' })
            : await deps.dispatch('get_events', { namespace });
        return json(events);
      },
    ),
  );

  server.registerTool(
    'top_pods',
    {
      annotations: READ_ONLY,
      description:
        'Live CPU/memory usage per pod and container (from metrics-server). Compare against requests/limits ' +
        'from get_resource when optimizing workload resources.',
      inputSchema: {
        namespace: z.string().optional(),
      },
    },
    guarded(deps, async ({ namespace }: { namespace?: string }) => {
      const metrics = await deps.dispatch('get_pod_metrics', { namespace });
      return json(metrics);
    }),
  );

  server.registerTool(
    'top_nodes',
    {
      annotations: READ_ONLY,
      description: 'Live CPU/memory usage and capacity per node.',
      inputSchema: {},
    },
    guarded(deps, async () => {
      const metrics = await deps.dispatch('get_node_metrics');
      return json(metrics);
    }),
  );

  // -------------------------------------------------------------------------
  // Safe Mutations — each one passes the Mutation Approval gate
  // -------------------------------------------------------------------------

  server.registerTool(
    'scale_workload',
    {
      annotations: MUTATION,
      description:
        'Safe Mutation: scale a Deployment, StatefulSet or ReplicaSet to a replica count. ' +
        'The user must approve unless they disabled approval in settings.',
      inputSchema: {
        kind: z.enum(['Deployment', 'StatefulSet', 'ReplicaSet']),
        namespace: z.string(),
        name: z.string(),
        replicas: z.number().int().min(0),
      },
    },
    guarded(
      deps,
      async ({ kind, namespace, name, replicas }: { kind: string; namespace: string; name: string; replicas: number }) =>
        approvedMutation(
          deps,
          {
            tool: 'scale_workload',
            resource: { kind, namespace, name },
            changes: [`replicas → ${replicas}`],
          },
          () => deps.dispatch('scale_workload', { kind, namespace, name, replicas }),
        ),
    ),
  );

  server.registerTool(
    'restart_rollout',
    {
      annotations: MUTATION,
      description:
        'Safe Mutation: rolling restart of a Deployment, StatefulSet or DaemonSet ' +
        '(kubectl rollout restart). The user must approve unless they disabled approval in settings.',
      inputSchema: {
        kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet']),
        namespace: z.string(),
        name: z.string(),
      },
    },
    guarded(deps, async ({ kind, namespace, name }: { kind: string; namespace: string; name: string }) =>
      approvedMutation(
        deps,
        {
          tool: 'restart_rollout',
          resource: { kind, namespace, name },
          changes: ['rolling restart'],
        },
        () => deps.dispatch('restart_workload', { kind, namespace, name }),
      ),
    ),
  );

  server.registerTool(
    'delete_pod',
    {
      annotations: DESTRUCTIVE,
      description:
        'Safe Mutation: delete ONE pod (its controller will recreate it). Cannot delete anything else. ' +
        'The user must approve unless they disabled approval in settings.',
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
      },
    },
    guarded(deps, async ({ namespace, name }: { namespace: string; name: string }) =>
      approvedMutation(
        deps,
        {
          tool: 'delete_pod',
          resource: { kind: 'Pod', namespace, name },
          changes: ['delete pod'],
        },
        () => deps.dispatch('delete_resource', { kind: 'Pod', namespace, name }),
      ),
    ),
  );

  server.registerTool(
    'update_container_resources',
    {
      annotations: MUTATION,
      description:
        "Safe Mutation: set one container's CPU/memory requests and/or limits on a Deployment, " +
        'StatefulSet, DaemonSet or ReplicaSet. Quantities are Kubernetes strings ("250m", "128Mi"). ' +
        'The user must approve unless they disabled approval in settings.',
      inputSchema: {
        kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']),
        namespace: z.string(),
        name: z.string(),
        container: z.string(),
        requests: z.record(z.string(), z.string()).optional().describe('e.g. {"cpu":"250m","memory":"128Mi"}'),
        limits: z.record(z.string(), z.string()).optional(),
      },
    },
    guarded(
      deps,
      async ({
        kind,
        namespace,
        name,
        container,
        requests,
        limits,
      }: {
        kind: string;
        namespace: string;
        name: string;
        container: string;
        requests?: Record<string, string>;
        limits?: Record<string, string>;
      }) => {
        const changes: string[] = [];
        if (requests) changes.push(`requests → ${JSON.stringify(requests)}`);
        if (limits) changes.push(`limits → ${JSON.stringify(limits)}`);
        return approvedMutation(
          deps,
          {
            tool: 'update_container_resources',
            resource: { kind, namespace, name, container },
            changes,
          },
          () => deps.dispatch('update_container_resources', { kind, namespace, name, container, requests, limits }),
        );
      },
    ),
  );
}
