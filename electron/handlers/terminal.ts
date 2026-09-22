// Terminal exec handler group — interactive shells over
// @kubernetes/client-node's WebSocket-based Exec API.
//
// Commands implemented:
//   - start_terminal_exec  { name, namespace, container, command } -> null
//   - send_terminal_input  { data }                                -> null
//   - resize_terminal      { width, height }  (width=cols, height=rows) -> null
//   - stop_terminal_exec   {}                                       -> null
//
// Event channels (payload shape MUST match the renderer consumer
// src/lib/components/terminal/TerminalView.svelte):
//   - terminal-output : string  (raw PTY chunk, utf8-decoded — terminal.write)
//   - terminal-exit   : null    (payload unused; signals the session ended)
//
// Session model: exactly ONE active session at a time, held in a single slot.
// Starting a new one stops the previous. stop_terminal_exec
// closes the WebSocket and emits terminal-exit. The session Map is cleaned on
// stop AND on stream death (status callback / ws close / error).
//
// Every start/stop bumps `generation`. A start captures its generation before
// awaiting the WebSocket handshake and re-checks it afterwards: if a stop or a
// newer start ran meanwhile, the late socket is closed and nothing is emitted.
// Status/close callbacks only act while their own socket is the active one.

import { PassThrough, Writable } from 'node:stream';

import { Exec } from '@kubernetes/client-node';
import type WebSocket from 'isomorphic-ws';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { kc } from '../k8s/client';
import { makeOutputCoalescer, type OutputCoalescer } from '../util/output-coalescer';

const TERMINAL_OUTPUT = 'terminal-output';
const TERMINAL_EXIT = 'terminal-exit';

/**
 * A stdout/stderr sink that decodes incoming PTY bytes to utf8 and forwards
 * each chunk to the renderer as a `terminal-output` string. It also masquerades
 * as a TTY (rows/columns + 'resize' events) so that Exec.exec() wires up the
 * k8s resize channel for it (see node_modules/@kubernetes/client-node/dist/
 * exec.js: `if (isResizable(stdout)) { ... handleResizes(stdout) }`).
 */
class OutputStream extends Writable {
  rows: number;
  columns: number;

  constructor(emit: (chunk: string) => void, cols: number, rows: number) {
    super();
    this.columns = cols;
    this.rows = rows;
    this.emit_ = emit;
  }

  private readonly emit_: (chunk: string) => void;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.emit_(text);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  /** Update the reported terminal size and fire 'resize' so the TerminalSizeQueue picks it up. */
  setSize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    this.emit('resize');
  }
}

// PTY output coalescing lives in util/output-coalescer.ts (shared with the
// Agent Session terminal).

interface Session {
  ws: WebSocket;
  stdin: PassThrough;
  stdout: OutputStream;
  output: OutputCoalescer;
}

/** Single active session. */
let session: Session | null = null;

/** Bumped by every start and stop; a pending start whose generation is stale is cancelled. */
let generation = 0;

/** Something that can open an exec WebSocket — `Exec` in production, a fake in tests. */
export type ExecClient = Pick<Exec, 'exec'>;

/** Tear down the active session if any. `notify` emits terminal-exit when true. */
function endSession(notify: boolean, ctx: HandlerCtx | null): void {
  const current = session;
  if (!current) return;
  session = null;

  // Deliver any buffered output before the exit event, then seal the
  // coalescer so late in-flight writes can't emit into a replacement session.
  try {
    current.output.close();
  } catch {
    /* ignore */
  }
  try {
    current.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    current.ws.close();
  } catch {
    /* ignore */
  }

  if (notify && ctx) {
    ctx.emit(TERMINAL_EXIT, null);
  }
}

/** End the active session without notifying (renderer reload/crash — main.ts hooks). */
export function stopAllTerminalSessions(): void {
  generation++;
  endSession(false, null);
}

export function register(
  handlers: HandlerMap,
  ctx: HandlerCtx,
  makeExec: () => ExecClient = () => new Exec(kc()),
): void {
  handlers.set('start_terminal_exec', async (args) => {
    const name = String(args.name ?? '');
    const namespace = String(args.namespace ?? '');
    const container =
      typeof args.container === 'string' && args.container.length > 0
        ? args.container
        : undefined;
    const command = Array.isArray(args.command)
      ? (args.command as unknown[]).map((c) => String(c))
      : ['/bin/sh'];

    if (!name) throw new Error('start_terminal_exec: missing pod name');
    if (!namespace) throw new Error('start_terminal_exec: missing namespace');

    // Stop any previous session first (single active slot). Do not notify the
    // renderer — it is intentionally replacing the session. Claiming a new
    // generation also cancels any start still in its handshake.
    const gen = ++generation;
    endSession(false, ctx);

    const stdin = new PassThrough();
    // Drop output once this start has been superseded, so a cancelled connect
    // (or a replaced session's final flush) never writes into the new terminal.
    const output = makeOutputCoalescer((text) => {
      if (gen === generation) ctx.emit(TERMINAL_OUTPUT, text);
    });
    const stdout = new OutputStream((text) => output.push(text), 80, 24);
    // stderr shares the same channel — interactive shells multiplex onto stdout
    // anyway, but a TTY-less write to stderr must still reach the user.
    const stderr = new OutputStream((text) => output.push(text), 80, 24);

    const exec = makeExec();

    let ws: WebSocket | undefined;
    try {
      ws = (await exec.exec(
        namespace,
        name,
        // empty string => server defaults to the pod's (sole) container
        container ?? '',
        command,
        stdout,
        stderr,
        stdin,
        true, // tty
        // status callback fires when the remote process exits — only end the
        // session if it is still this socket's (a replaced one must not kill
        // its successor).
        () => {
          if (ws && session && session.ws === ws) {
            endSession(true, ctx);
          }
        },
      )) as unknown as WebSocket;
    } catch (err) {
      // Clean up the streams we created before rejecting.
      output.close();
      stdin.end();
      // Superseded while connecting: the caller already moved on.
      if (gen !== generation) return null;
      throw new Error(`Failed to start terminal exec: ${(err as Error).message}`);
    }

    // A stop or a newer start ran during the handshake: close the late socket
    // instead of opening a shell nobody is attached to.
    if (gen !== generation) {
      output.close();
      stdin.end();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return null;
    }

    session = { ws, stdin, stdout, output };

    // If the socket dies for any reason (server close, network error), make sure
    // we clean up and tell the renderer the session ended.
    const opened = ws;
    const onClose = (): void => {
      if (session && session.ws === opened) {
        endSession(true, ctx);
      }
    };
    ws.onclose = onClose;
    ws.onerror = onClose;

    return null;
  });

  handlers.set('send_terminal_input', (args) => {
    const data = typeof args.data === 'string' ? args.data : '';
    if (session && data.length > 0) {
      session.stdin.write(data);
    }
    return null;
  });

  handlers.set('resize_terminal', (args) => {
    // Renderer sends width=cols, height=rows (see TerminalView.svelte onResize).
    const width = typeof args.width === 'number' ? args.width : 0;
    const height = typeof args.height === 'number' ? args.height : 0;
    if (session && width > 0 && height > 0) {
      session.stdout.setSize(width, height);
    }
    return null;
  });

  handlers.set('stop_terminal_exec', () => {
    // Also cancels a start still in its handshake.
    generation++;
    endSession(true, ctx);
    return null;
  });
}
