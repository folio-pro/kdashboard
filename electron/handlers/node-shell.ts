// Handler module: node-shell — a host shell on a node (Lens-style).
//
// Commands:
//   start_node_shell { nodeName, namespace? } -> { name, namespace }
//   stop_node_shell  { name, namespace }      -> null
//
// start_node_shell creates a privileged hostPID pod pinned to the node and
// waits until it runs. The pod only sleeps — the renderer then execs
// `nsenter -t 1 -m -u -i -n -p -- <shell>` into it through the regular
// terminal subsystem, which drops into the HOST's mount/UTS/IPC/net/pid
// namespaces (the same trick as kubectl-node-shell). busybox ships an
// nsenter applet, so the tiny debug image is enough.
//
// The pod is transient: the renderer deletes it when the terminal closes
// (stop_node_shell), and `activeDeadlineSeconds` reaps it after an hour in
// case the app dies with the shell open.

import { randomBytes } from 'node:crypto';

import type { V1Pod } from '@kubernetes/client-node';

import { getCoreV1Api } from '../k8s/client.js';
import { k8sErrorMessage } from '../k8s/errors.js';
import type { HandlerCtx, HandlerMap } from '../dispatch.js';

const NODE_SHELL_IMAGE = 'busybox:1.36';
const NODE_SHELL_NAMESPACE = 'kube-system';
/** Safety reaper: the kubelet kills the pod even if the app never cleans up. */
const NODE_SHELL_DEADLINE_SECONDS = 3600;

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 500;

/** Label that marks node-shell pods; the renderer keys its exec wrapper on it. */
export const NODE_SHELL_LABEL = 'kdashboard.io/node-shell';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing or invalid '${key}' argument`);
  }
  return v;
}

/** The transient pod spec: privileged, host namespaces, pinned to the node. */
export function buildNodeShellPod(name: string, namespace: string, nodeName: string): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'kdashboard',
        [NODE_SHELL_LABEL]: 'true',
      },
      annotations: { [NODE_SHELL_LABEL]: nodeName },
    },
    spec: {
      nodeName,
      hostPID: true,
      hostIPC: true,
      hostNetwork: true,
      restartPolicy: 'Never',
      activeDeadlineSeconds: NODE_SHELL_DEADLINE_SECONDS,
      terminationGracePeriodSeconds: 0,
      // Cordoned/tainted nodes are exactly where a host shell is needed.
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'shell',
          image: NODE_SHELL_IMAGE,
          // Sleep only — the PTY comes from a later exec (nsenter wrapper).
          command: ['sh', '-c', 'sleep 2147483647'],
          securityContext: { privileged: true },
        },
      ],
    },
  };
}

async function waitForPodRunning(name: string, namespace: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastPhase = 'Pending';

  while (Date.now() < deadline) {
    const pod = await getCoreV1Api().readNamespacedPod({ name, namespace });
    const phase = pod.status?.phase ?? 'Pending';
    if (phase === 'Running') return;
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`Node shell pod ended prematurely (phase ${phase})`);
    }
    lastPhase = phase;
    await sleep(READY_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for the node shell pod to start (last phase: ${lastPhase})`);
}

/**
 * Best-effort delete; NotFound is success (something else reaped it). Only
 * pods carrying the node-shell label are deletable through this path — the
 * renderer supplies name/namespace, and without the guard stop_node_shell
 * would be a force-delete primitive for arbitrary pods.
 */
async function deleteNodeShellPod(name: string, namespace: string): Promise<void> {
  try {
    const pod = await getCoreV1Api().readNamespacedPod({ name, namespace });
    if (pod.metadata?.labels?.[NODE_SHELL_LABEL] !== 'true') {
      throw new Error(`Pod ${namespace}/${name} is not a node shell pod`);
    }
    await getCoreV1Api().deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 });
  } catch (err) {
    const msg = k8sErrorMessage(err);
    if (!/not found/i.test(msg)) throw new Error(msg);
  }
}

async function startNodeShell(args: Record<string, unknown>): Promise<{ name: string; namespace: string }> {
  const nodeName = reqStr(args, 'nodeName');
  const namespace =
    typeof args.namespace === 'string' && args.namespace.length > 0
      ? args.namespace
      : NODE_SHELL_NAMESPACE;
  const name = `kdashboard-node-shell-${randomBytes(3).toString('hex')}`;

  try {
    await getCoreV1Api().createNamespacedPod({
      namespace,
      body: buildNodeShellPod(name, namespace, nodeName),
    });
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }

  try {
    await waitForPodRunning(name, namespace);
  } catch (err) {
    // Don't leave a dead privileged pod behind when startup fails.
    await deleteNodeShellPod(name, namespace).catch(() => {});
    throw new Error(k8sErrorMessage(err));
  }

  return { name, namespace };
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('start_node_shell', async (args) => startNodeShell(args));
  handlers.set('stop_node_shell', async (args) => {
    await deleteNodeShellPod(reqStr(args, 'name'), reqStr(args, 'namespace'));
    return null;
  });
}
