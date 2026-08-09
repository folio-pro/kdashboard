// Handler module: node-ops
//
// Commands:
//   cordon_node -> mark a node (un)schedulable via spec.unschedulable
//   drain_node  -> cordon, then evict every evictable pod off the node
//
// Event channel:
//   node-drain-progress -> { node, phase, evicted, total, pod? } as the drain
//                          walks the pod list, so the dialog can show progress.
//
// The drain follows kubectl's rules: static (mirror) pods and already-terminal
// pods are skipped, DaemonSet pods are skipped unless asked otherwise, and pods
// with no controller or with emptyDir data abort the drain unless the caller
// opted in. Eviction goes through the policy/v1 Eviction subresource, so
// PodDisruptionBudgets are honoured — a 429 means "blocked by a PDB", which we
// retry until the timeout instead of forcing a delete.

import { CoreV1Api, KubernetesObjectApi, PatchStrategy, type KubernetesObject, type V1Pod } from '@kubernetes/client-node';

import { kc, getCoreV1Api } from '../k8s/client.js';
import { k8sErrorMessage } from '../k8s/errors.js';
import type { HandlerCtx, HandlerMap } from '../dispatch.js';

const DRAIN_CHANNEL = 'node-drain-progress';

/** Delay between eviction retries when a PDB blocks the eviction (429). */
const EVICT_RETRY_MS = 2_000;
/** How many pods to evict at once (kubectl uses an unbounded fan-out). */
const EVICT_CONCURRENCY = 10;
/** Default overall drain budget. */
const DEFAULT_TIMEOUT_SECONDS = 300;

const MIRROR_POD_ANNOTATION = 'kubernetes.io/config.mirror';

// ---------------------------------------------------------------------------
// Wire shapes consumed by src/lib/actions/node-ops.ts
// ---------------------------------------------------------------------------

export interface DrainSkip {
  pod: string;
  namespace: string;
  reason: string;
}

export interface DrainFailure {
  pod: string;
  namespace: string;
  error: string;
}

export interface DrainResult {
  node: string;
  evicted: string[];
  skipped: DrainSkip[];
  failed: DrainFailure[];
  /** True when the drain hit its timeout with pods still on the node. */
  timed_out: boolean;
}

export interface DrainProgress {
  node: string;
  phase: 'cordoning' | 'listing' | 'evicting' | 'waiting' | 'done';
  evicted: number;
  total: number;
  pod?: string;
}

// ---------------------------------------------------------------------------
// Arg coercion
// ---------------------------------------------------------------------------

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`Missing or invalid '${key}' argument`);
  }
  return v;
}

function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new Error(`Invalid '${key}' argument`);
  return v;
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`Invalid '${key}' argument`);
  }
  return v;
}

function core(): CoreV1Api {
  return getCoreV1Api();
}

// ---------------------------------------------------------------------------
// cordon / uncordon
// ---------------------------------------------------------------------------

/** Patch spec.unschedulable on a node. `unschedulable: false` uncordons it. */
async function cordonNode(args: Record<string, unknown>): Promise<null> {
  const name = reqStr(args, 'name');
  const unschedulable = optBool(args, 'unschedulable', true);

  const patch = {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name },
    spec: { unschedulable },
  } as unknown as KubernetesObject;

  try {
    await KubernetesObjectApi.makeApiClient(kc()).patch(
      patch,
      undefined, // pretty
      undefined, // dryRun
      undefined, // fieldManager
      undefined, // force
      PatchStrategy.MergePatch,
    );
    return null;
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// drain
// ---------------------------------------------------------------------------

interface DrainOptions {
  ignoreDaemonSets: boolean;
  deleteEmptyDirData: boolean;
  force: boolean;
  gracePeriodSeconds?: number;
  timeoutSeconds: number;
}

function ownerKind(pod: V1Pod): string | undefined {
  const refs = pod.metadata?.ownerReferences ?? [];
  return refs.length > 0 ? refs[0]!.kind : undefined;
}

function hasEmptyDir(pod: V1Pod): boolean {
  return (pod.spec?.volumes ?? []).some((v) => v.emptyDir !== undefined);
}

function isMirrorPod(pod: V1Pod): boolean {
  return MIRROR_POD_ANNOTATION in (pod.metadata?.annotations ?? {});
}

function isTerminal(pod: V1Pod): boolean {
  const phase = pod.status?.phase;
  return phase === 'Succeeded' || phase === 'Failed';
}

interface Classified {
  evictable: V1Pod[];
  skipped: DrainSkip[];
  /** Pods that abort the drain unless the caller passed the matching flag. */
  blockers: string[];
}

/**
 * Split the node's pods into what we evict, what we skip, and what blocks the
 * drain outright. Mirrors kubectl drain's precedence: mirror pods and terminal
 * pods are never evicted, DaemonSet pods are a skip (or a blocker), and the
 * unmanaged / emptyDir checks are opt-in overrides.
 */
export function classifyPods(pods: V1Pod[], opts: DrainOptions): Classified {
  const evictable: V1Pod[] = [];
  const skipped: DrainSkip[] = [];
  const blockers: string[] = [];

  for (const pod of pods) {
    const name = pod.metadata?.name ?? '';
    const namespace = pod.metadata?.namespace ?? '';
    const ref = `${namespace}/${name}`;

    if (isMirrorPod(pod)) {
      skipped.push({ pod: name, namespace, reason: 'static pod (managed by the kubelet)' });
      continue;
    }
    if (isTerminal(pod)) {
      skipped.push({ pod: name, namespace, reason: `pod already ${pod.status?.phase?.toLowerCase()}` });
      continue;
    }

    const kind = ownerKind(pod);
    if (kind === 'DaemonSet') {
      if (opts.ignoreDaemonSets) {
        skipped.push({ pod: name, namespace, reason: 'DaemonSet-managed' });
      } else {
        blockers.push(`${ref} is DaemonSet-managed (enable "Ignore DaemonSets")`);
      }
      continue;
    }
    if (kind === undefined && !opts.force) {
      blockers.push(`${ref} has no controller (enable "Force" to evict it anyway)`);
      continue;
    }
    if (hasEmptyDir(pod) && !opts.deleteEmptyDirData) {
      blockers.push(`${ref} uses emptyDir storage (enable "Delete emptyDir data" to discard it)`);
      continue;
    }

    evictable.push(pod);
  }

  return { evictable, skipped, blockers };
}

/** HTTP status of a client-node error, when it carries one. */
function statusOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'number') return code;
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown when the drain's budget runs out with the pod still in place. */
class DrainTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrainTimeout';
  }
}

/**
 * Evict one pod, retrying while a PodDisruptionBudget rejects it (429) until
 * `deadline`. A 404 means the pod is already gone — that counts as success.
 */
async function evictPod(pod: V1Pod, opts: DrainOptions, deadline: number): Promise<void> {
  const name = pod.metadata?.name ?? '';
  const namespace = pod.metadata?.namespace ?? '';

  for (;;) {
    try {
      await core().createNamespacedPodEviction({
        name,
        namespace,
        body: {
          apiVersion: 'policy/v1',
          kind: 'Eviction',
          metadata: { name, namespace },
          deleteOptions:
            opts.gracePeriodSeconds === undefined
              ? undefined
              : { gracePeriodSeconds: opts.gracePeriodSeconds },
        },
      });
      return;
    } catch (err) {
      const status = statusOf(err);
      if (status === 404) return; // already gone
      if (status !== 429) throw new Error(k8sErrorMessage(err));
      if (Date.now() >= deadline) {
        throw new DrainTimeout('blocked by a PodDisruptionBudget until the drain timed out');
      }
      await sleep(EVICT_RETRY_MS);
    }
  }
}

async function drainNode(args: Record<string, unknown>, ctx: HandlerCtx): Promise<DrainResult> {
  const name = reqStr(args, 'name');
  const opts: DrainOptions = {
    ignoreDaemonSets: optBool(args, 'ignoreDaemonSets', true),
    deleteEmptyDirData: optBool(args, 'deleteEmptyDirData', false),
    force: optBool(args, 'force', false),
    gracePeriodSeconds: optInt(args, 'gracePeriodSeconds'),
    timeoutSeconds: optInt(args, 'timeoutSeconds') ?? DEFAULT_TIMEOUT_SECONDS,
  };
  const deadline = Date.now() + opts.timeoutSeconds * 1000;

  const progress = (p: Omit<DrainProgress, 'node'>): void => {
    ctx.emit(DRAIN_CHANNEL, { node: name, ...p } satisfies DrainProgress);
  };

  progress({ phase: 'cordoning', evicted: 0, total: 0 });
  await cordonNode({ name, unschedulable: true });

  progress({ phase: 'listing', evicted: 0, total: 0 });
  let pods: V1Pod[];
  try {
    const resp = await core().listPodForAllNamespaces({
      fieldSelector: `spec.nodeName=${name}`,
    });
    pods = resp.items ?? [];
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  const { evictable, skipped, blockers } = classifyPods(pods, opts);
  if (blockers.length > 0) {
    // The node stays cordoned — that is what kubectl does too, and it is the
    // half of the operation the user unambiguously asked for.
    throw new Error(`Cannot drain ${name}:\n- ${blockers.join('\n- ')}`);
  }

  const evicted: string[] = [];
  const failed: DrainFailure[] = [];
  let timedOut = false;

  // Evict concurrently, like kubectl does. Sequentially, a single pod parked on
  // a PodDisruptionBudget burns the whole budget retrying and every pod behind
  // it is reported as "timed out" without an eviction ever being attempted.
  const queue = [...evictable];
  const worker = async (): Promise<void> => {
    for (;;) {
      const pod = queue.shift();
      if (!pod) return;
      const podName = pod.metadata?.name ?? '';
      const namespace = pod.metadata?.namespace ?? '';
      progress({ phase: 'evicting', evicted: evicted.length, total: evictable.length, pod: podName });

      if (Date.now() >= deadline) {
        timedOut = true;
        failed.push({ pod: podName, namespace, error: 'drain timed out before this pod was evicted' });
        continue;
      }

      try {
        await evictPod(pod, opts, deadline);
        evicted.push(podName);
      } catch (err) {
        if (err instanceof DrainTimeout) timedOut = true;
        failed.push({ pod: podName, namespace, error: String(err instanceof Error ? err.message : err) });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(EVICT_CONCURRENCY, evictable.length) }, () => worker()),
  );

  progress({ phase: 'done', evicted: evicted.length, total: evictable.length });

  return { node: name, evicted, skipped, failed, timed_out: timedOut };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
  handlers.set('cordon_node', async (args) => cordonNode(args));
  handlers.set('drain_node', async (args) => drainNode(args, ctx));
}
