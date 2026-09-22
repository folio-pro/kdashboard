// Port-forward streaming subsystem.
//
// For each session the renderer starts, we bind a local TCP listener
// (net.createServer) and pipe every incoming
// connection through the K8s port-forward WebSocket via @kubernetes/client-node's
// PortForward. Session state lives in a module-level Map keyed by the sessionId
// the renderer uses; stop_port_forward (or an unexpected listener death) closes
// the server, destroys live sockets, and emits `port-forward-closed` EXACTLY
// once. A connection that fails to open probes the target pod: when the pod is
// gone or terminal the session is closed the same way, since every later
// connection would fail too.
//
// Renderer contract (src/lib/stores/k8s.svelte.ts):
//   - start_port_forward args (camelCase): { podName, namespace, containerPort,
//     localPort, sessionId }  — translated from the snake-case PortForwardInfo by
//     addPortForward() before invoke(); the frontend is the source of truth.
//   - stop_port_forward args (camelCase): { sessionId }.
//   - start returns { session_id, local_port } (snake_case — matches the
//     renderer's invoke<{ session_id; local_port }> ).
//   - `port-forward-closed` payload: { session_id, reason } — `reason` is a
//     short user-facing phrase ("pod web-abc was deleted"), or null.

import * as net from 'node:net';
import { PassThrough } from 'node:stream';

import { PortForward } from '@kubernetes/client-node';
import type { V1Pod } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { kc, getCoreV1Api } from '../k8s/client';

const CLOSED_CHANNEL = 'port-forward-closed';

/** What the port-forward handlers need from the cluster (injected by tests). */
export interface PortForwardDeps {
  readPod(name: string, namespace: string): Promise<Pick<V1Pod, 'status' | 'metadata'>>;
  /** One forwarder per session, bound to the kubeconfig current at start. */
  forwarder(): Pick<PortForward, 'portForward'>;
}

const defaultDeps: PortForwardDeps = {
  readPod: (name, namespace) => getCoreV1Api().readNamespacedPod({ name, namespace }),
  forwarder: () => new PortForward(kc()),
};

/** Payload of `port-forward-closed`. */
export interface PortForwardClosed {
  session_id: string;
  reason: string | null;
}

interface Session {
  server: net.Server;
  sockets: Set<net.Socket>;
  /** Set true by stop_port_forward so the server `close` handler stays silent. */
  closing: boolean;
  /** Guards against emitting `port-forward-closed` more than once. */
  emitted: boolean;
  /** A pod probe after a failed connection is in flight — one at a time. */
  probing: boolean;
}

/** Active port-forward sessions, keyed by the renderer's sessionId. */
const sessions = new Map<string, Session>();

/** Coerce an arg that may be string or number into a finite port number. */
function toPort(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return n;
}

/**
 * Emit `port-forward-closed` for a session at most once and drop it from the
 * map. On an explicit stop we still tear down the server but suppress the emit
 * (the renderer initiated it); on unexpected death we emit so the UI can
 * removeBySessionId and tell the user why.
 */
function finalizeSession(
  sessionId: string,
  ctx: HandlerCtx | null,
  emit: boolean,
  reason: string | null = null,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);

  for (const sock of session.sockets) {
    sock.destroy();
  }
  session.sockets.clear();

  try {
    session.server.close();
  } catch {
    // already closed — ignore
  }

  if (emit && ctx && !session.emitted) {
    session.emitted = true;
    const payload: PortForwardClosed = { session_id: sessionId, reason };
    ctx.emit(CLOSED_CHANNEL, payload);
  }
}

function statusOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'number') return code;
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Why a forward to `podName` can no longer work, or null when the pod still
 * looks usable — or when the apiserver could not say: a flaky apiserver must
 * not kill a forward that may recover.
 */
async function deadTargetReason(deps: PortForwardDeps, podName: string, namespace: string): Promise<string | null> {
  let pod: Pick<V1Pod, 'status' | 'metadata'>;
  try {
    pod = await deps.readPod(podName, namespace);
  } catch (err) {
    return statusOf(err) === 404 ? `pod ${podName} was deleted` : null;
  }
  const phase = pod.status?.phase;
  if (phase === 'Succeeded' || phase === 'Failed') return `pod ${podName} ${phase.toLowerCase()}`;
  if (pod.metadata?.deletionTimestamp) return `pod ${podName} is terminating`;
  return null;
}

/** Tear down every session without emitting (renderer reload/crash — main.ts hooks). */
export function stopAllPortForwards(): void {
  for (const [sessionId, session] of sessions) {
    session.closing = true;
    finalizeSession(sessionId, null, false);
  }
}

export function register(handlers: HandlerMap, ctx: HandlerCtx, deps: PortForwardDeps = defaultDeps): void {
  handlers.set('start_port_forward', async (args) => {
    const podName = String(args.podName ?? args.pod_name ?? '');
    const namespace = String(args.namespace ?? '');
    const containerPort = toPort(
      args.containerPort ?? args.container_port ?? args.remotePort ?? args.targetPort,
      'containerPort',
    );
    const requestedLocalPort = toPort(args.localPort ?? args.local_port ?? 0, 'localPort');
    const sessionId = String(args.sessionId ?? args.session_id ?? '');

    if (!podName) throw new Error('start_port_forward: missing podName');
    if (!namespace) throw new Error('start_port_forward: missing namespace');
    if (!sessionId) throw new Error('start_port_forward: missing sessionId');

    if (sessions.has(sessionId)) {
      throw new Error(`Port-forward already active for session: ${sessionId}`);
    }

    // Reserve the slot before the first await: a second start with the same id
    // (double-click, saved-forward restore racing a manual start) must see it,
    // or both would bind and the loser's listener would leak.
    const sockets = new Set<net.Socket>();
    const server = net.createServer();
    const session: Session = { server, sockets, closing: false, emitted: false, probing: false };
    sessions.set(sessionId, session);

    /** A stop_port_forward during one of the awaits below drops the slot. */
    const stillOwned = (): boolean => sessions.get(sessionId) === session;
    const abandon = (): void => {
      if (stillOwned()) sessions.delete(sessionId);
      session.closing = true;
      if (server.listening) server.close();
    };
    const stoppedEarly = (): Error => new Error(`Port-forward ${sessionId} was stopped before it started`);

    try {
      // Verify the pod exists before binding.
      await deps.readPod(podName, namespace);
    } catch (err) {
      abandon();
      throw err;
    }
    if (!stillOwned()) {
      abandon();
      throw stoppedEarly();
    }

    const forward = deps.forwarder();

    // A connection failed to open. If the pod is gone, every later connection
    // fails the same way — close the session so the UI stops listing a dead
    // forward, and say why.
    const probeTarget = (): void => {
      if (session.probing || session.closing) return;
      session.probing = true;
      void deadTargetReason(deps, podName, namespace).then((reason) => {
        session.probing = false;
        if (reason && !session.closing && stillOwned()) {
          session.closing = true;
          finalizeSession(sessionId, ctx, true, reason);
        }
      });
    };

    server.on('connection', (socket) => {
      sockets.add(socket);

      // Streams bridging the local TCP socket <-> the pod port via the WS:
      //   output: bytes coming FROM the pod -> write to the socket
      //   err:    error channel from the pod (best-effort, also to the socket)
      //   input:  bytes coming FROM the socket -> sent TO the pod
      const output = new PassThrough();
      const errStream = new PassThrough();
      const input = new PassThrough();

      output.pipe(socket);
      errStream.pipe(socket);
      socket.pipe(input);

      const cleanupConnection = (): void => {
        sockets.delete(socket);
        output.destroy();
        errStream.destroy();
        // end(), not destroy(): client-node only closes the apiserver WebSocket
        // on stdin's 'end' event (web-socket-handler.js handleStandardInput);
        // destroy() skips 'end' and leaks the WS.
        input.end();
      };

      socket.on('error', cleanupConnection);
      socket.on('close', cleanupConnection);

      // One WebSocket per TCP connection. A failure here kills THIS connection;
      // the session survives unless the probe finds the pod gone.
      forward
        .portForward(namespace, podName, [containerPort], output, errStream, input)
        .then((ws) => {
          const w = ws as { on?: (event: string, fn: () => void) => void };
          w.on?.('close', () => socket.destroy());
          w.on?.('error', () => socket.destroy());
        })
        .catch(() => {
          socket.destroy();
          probeTarget();
        });
    });

    // Bind. localPort 0 => OS picks a free port; we echo back the actual port.
    const actualPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => {
        if (stillOwned()) sessions.delete(sessionId);
        reject(new Error(`Failed to bind local port ${requestedLocalPort}: ${err.message}`));
      };
      server.once('error', onError);
      server.listen(requestedLocalPort, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to determine bound local port'));
        }
      });
    });
    if (!stillOwned()) {
      abandon();
      throw stoppedEarly();
    }

    // If the listener dies unexpectedly (and we are not the ones closing it),
    // treat the session as ended and notify the renderer. Registered only AFTER
    // a successful bind — otherwise a bind failure (e.g. EADDRINUSE) would also
    // hit these and emit a spurious `port-forward-closed` for a session that
    // never started.
    server.on('close', () => {
      if (!session.closing) {
        finalizeSession(sessionId, ctx, true, 'the local listener closed');
      }
    });
    server.on('error', (err) => {
      if (!session.closing) {
        finalizeSession(sessionId, ctx, true, `local listener failed: ${err.message}`);
      }
    });

    // snake_case keys, as the renderer expects.
    return { session_id: sessionId, local_port: actualPort };
  });

  handlers.set('stop_port_forward', async (args) => {
    const sessionId = String(args.sessionId ?? args.session_id ?? '');
    if (!sessionId) throw new Error('stop_port_forward: missing sessionId');

    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No active port-forward with session_id: ${sessionId}`);
    }

    // Renderer-initiated stop: tear down WITHOUT emitting port-forward-closed
    // (the UI already knows).
    session.closing = true;
    finalizeSession(sessionId, ctx, false);
    return null;
  });
}
