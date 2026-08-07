// Port-forward streaming subsystem (Tauri -> Electron migration, phase 2).
//
// Ports src-tauri/src/k8s/portforward.rs. For each session the renderer starts,
// we bind a local TCP listener (net.createServer) and pipe every incoming
// connection through the K8s port-forward WebSocket via @kubernetes/client-node's
// PortForward. Session state lives in a module-level Map keyed by the sessionId
// the renderer uses; stop_port_forward (or an unexpected listener death) closes
// the server, destroys live sockets, and emits `port-forward-closed` EXACTLY
// once with the sessionId STRING (the shape the renderer's listen<string> wants).
//
// Renderer contract (src/lib/stores/k8s.svelte.ts):
//   - start_port_forward args (camelCase): { podName, namespace, containerPort,
//     localPort, sessionId }  — translated from the snake-case PortForwardInfo by
//     addPortForward() before invoke(); the frontend is the source of truth.
//   - stop_port_forward args (camelCase): { sessionId }.
//   - start returns { session_id, local_port } (snake_case — matches Rust
//     PortForwardResult and the renderer's invoke<{ session_id; local_port }> ).
//   - `port-forward-closed` payload === sessionId (string).

import * as net from 'node:net';
import { PassThrough } from 'node:stream';

import { PortForward } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { kc, getCoreV1Api } from '../k8s/client';

const CLOSED_CHANNEL = 'port-forward-closed';

interface Session {
  server: net.Server;
  sockets: Set<net.Socket>;
  /** Set true by stop_port_forward so the server `close` handler stays silent. */
  closing: boolean;
  /** Guards against emitting `port-forward-closed` more than once. */
  emitted: boolean;
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
 * map. Mirrors the Rust cleanup: on explicit stop we still tear down the server
 * but suppress the emit (the renderer initiated it); on unexpected death we emit
 * so the UI can removeBySessionId.
 */
function finalizeSession(sessionId: string, ctx: HandlerCtx | null, emit: boolean): void {
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
    ctx.emit(CLOSED_CHANNEL, sessionId);
  }
}

/** Tear down every session without emitting (renderer reload/crash — main.ts hooks). */
export function stopAllPortForwards(): void {
  for (const [sessionId, session] of sessions) {
    session.closing = true;
    finalizeSession(sessionId, null, false);
  }
}

export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
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

    // Verify the pod exists before binding (mirrors pods.get() in the Rust).
    await getCoreV1Api().readNamespacedPod({ name: podName, namespace });

    const forward = new PortForward(kc());

    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
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

      // One WebSocket per TCP connection (matches the Rust per-connection
      // pods.portforward()). Errors here only kill THIS connection, not the
      // session — the listener stays up for the next client.
      forward
        .portForward(namespace, podName, [containerPort], output, errStream, input)
        .then((ws) => {
          ws.on('close', () => socket.destroy());
          ws.on('error', () => socket.destroy());
        })
        .catch(() => {
          socket.destroy();
        });
    });

    const session: Session = { server, sockets, closing: false, emitted: false };
    sessions.set(sessionId, session);

    // Bind. localPort 0 => OS picks a free port; we echo back the actual port.
    const actualPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => {
        sessions.delete(sessionId);
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

    // If the listener dies unexpectedly (and we are not the ones closing it),
    // treat the session as ended and notify the renderer. Registered only AFTER
    // a successful bind — otherwise a bind failure (e.g. EADDRINUSE) would also
    // hit these and emit a spurious `port-forward-closed` for a session that
    // never started.
    server.on('close', () => {
      if (!session.closing) {
        finalizeSession(sessionId, ctx, true);
      }
    });
    server.on('error', () => {
      if (!session.closing) {
        finalizeSession(sessionId, ctx, true);
      }
    });

    // Same shape as Rust PortForwardResult: snake_case keys.
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
    // (the UI already knows; matches the `cancelled` branch in the Rust).
    session.closing = true;
    finalizeSession(sessionId, ctx, false);
    return null;
  });
}
