// Handler module: debug — ephemeral debug containers (kubectl debug).
//
// Commands:
//   debug_pod -> add an ephemeral debug container to a running pod and wait
//                until it is running, so the renderer can exec straight into
//                it with the existing terminal subsystem.
//
// Flow mirrors `kubectl debug <pod> --image=<img> --target=<container>`:
// a strategic-merge patch on the pod's `ephemeralcontainers` subresource
// (ephemeralContainers merge by name, so the patch carries only the new
// container). The container runs a long sleep instead of an interactive
// shell — the app's exec model attaches a PTY afterwards via
// start_terminal_exec, exactly like it does for regular containers.
//
// Ephemeral containers cannot be removed from a pod once added (API
// restriction) — they die with the pod. The UI copy reflects that.

import { randomBytes } from 'node:crypto';

import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';

import { getCoreV1Api } from '../k8s/client.js';
import { k8sErrorMessage } from '../k8s/errors.js';
import type { HandlerCtx, HandlerMap } from '../dispatch.js';

/** Default debug image: small, ubiquitous, has a usable shell. */
const DEFAULT_DEBUG_IMAGE = 'busybox:1.36';

/** How long to wait for the runtime to start the debug container. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 500;

export interface EphemeralContainerStatus {
  name?: string;
  state?: { running?: unknown; waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; exitCode?: number } };
}

/** One poll's verdict on the debug container. */
export type DebugContainerState =
  | { kind: 'running' }
  | { kind: 'pending'; detail: string }
  | { kind: 'failed'; message: string };

/**
 * Classify a single observation of the debug container's status. Pure — the
 * poll loop above it owns timing. Terminations and pull failures are terminal:
 * neither resolves by waiting, so the caller fails fast with the real reason.
 */
export function classifyDebugState(
  status: EphemeralContainerStatus | undefined,
): DebugContainerState {
  if (status?.state?.running) return { kind: 'running' };
  if (status?.state?.terminated) {
    const t = status.state.terminated;
    return {
      kind: 'failed',
      message: `Debug container terminated (${t.reason ?? 'unknown'}, exit code ${t.exitCode ?? '?'})`,
    };
  }
  if (status?.state?.waiting) {
    const w = status.state.waiting;
    if (w.reason === 'ErrImagePull' || w.reason === 'ImagePullBackOff') {
      return { kind: 'failed', message: `Debug container image pull failed: ${w.message ?? w.reason}` };
    }
    return { kind: 'pending', detail: w.reason ?? 'waiting' };
  }
  return { kind: 'pending', detail: 'not yet reported' };
}

/**
 * The strategic-merge patch that adds the debug container. Ephemeral
 * containers merge by name, so the patch carries only the new one.
 */
export function buildDebugPatch(
  container: string,
  image: string,
  target: string | undefined,
): Record<string, unknown> {
  return {
    spec: {
      ephemeralContainers: [
        {
          name: container,
          image,
          // Keep the container alive; the PTY comes from a later exec. busybox
          // sh has no `sleep infinity`, so use the largest portable duration.
          command: ['sh', '-c', 'sleep 2147483647'],
          imagePullPolicy: 'IfNotPresent',
          terminationMessagePolicy: 'File',
          ...(target ? { targetContainerName: target } : {}),
        },
      ],
    },
  };
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing or invalid '${key}' argument`);
  }
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the named ephemeral container reports `running`. Surfaces waiting
 * reasons (ImagePullBackOff, …) and terminations as errors instead of letting
 * the caller exec into a dead container and get an opaque failure.
 */
async function waitForDebugContainer(
  name: string,
  namespace: string,
  container: string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastState = 'not yet reported';

  while (Date.now() < deadline) {
    const pod = await getCoreV1Api().readNamespacedPod({ name, namespace });
    const statuses = (pod.status?.ephemeralContainerStatuses ?? []) as EphemeralContainerStatus[];
    const verdict = classifyDebugState(statuses.find((s) => s.name === container));

    if (verdict.kind === 'running') return;
    if (verdict.kind === 'failed') throw new Error(verdict.message);
    lastState = verdict.detail;

    await sleep(READY_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for debug container to start (last state: ${lastState})`);
}

/**
 * debug_pod: { name, namespace, image?, target? } -> { container }
 * `target` shares the target container's process namespace (when the runtime
 * supports it), so its processes are visible from the debug shell.
 */
async function debugPod(args: Record<string, unknown>): Promise<{ container: string }> {
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');
  const image = optStr(args, 'image') ?? DEFAULT_DEBUG_IMAGE;
  const target = optStr(args, 'target');

  const container = `debug-${randomBytes(3).toString('hex')}`;
  const patch = buildDebugPatch(container, image, target);

  try {
    await getCoreV1Api().patchNamespacedPodEphemeralcontainers(
      { name, namespace, body: patch },
      setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch),
    );
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  try {
    await waitForDebugContainer(name, namespace, container);
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  return { container };
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('debug_pod', async (args) => debugPod(args));
}
