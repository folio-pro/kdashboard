// Logs streaming handler — ports the Tauri "logs" subsystem to
// @kubernetes/client-node's Log streaming API.
//
// Rust source ported (faithful): src-tauri/src/k8s/logs.rs
//
// Commands implemented (EXACT Tauri command strings):
//   - stream_pod_logs        -> streams ONE pod/container
//   - stream_multi_pod_logs  -> streams N pods under ONE logical stream, each
//                               line prefixed with `[pod-name] `
//   - stop_log_stream        -> takes NO args; aborts whatever is streaming
//
// Event channel: "log-lines"
//   PAYLOAD SHAPE: string[]  (a batch of COMPLETE log lines, no trailing
//   newline per line). The renderer (src/lib/components/logs/LogViewer.svelte)
//   does listen<string[]>("log-lines", e => for (line of e.payload) ...), so
//   every emit MUST be a string[].
//
// Renderer arg keys (source of truth — src/.../LogViewer.svelte ~280-315):
//   stream_pod_logs:       { name, namespace, container, tailLines,
//                            sinceSeconds, timestamps, previous }
//   stream_multi_pod_logs: { pods, namespace, container, tailLines,
//                            sinceSeconds, timestamps, previous }
//   (container/previous may be null; sinceSeconds may be null; the renderer
//    sends camelCase tailLines/sinceSeconds.)
//
// Session semantics (mirrors the Rust single global STOP_FLAG): there is ONE
// active logical log stream at a time. Starting a new stream aborts any prior
// one. stop_log_stream aborts all underlying streams and clears state. Each
// stream is also cleaned up when it ends/errors on its own.

import { Writable } from 'node:stream';

import { Log } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { kc } from '../k8s/client';

const LOG_CHANNEL = 'log-lines';

/** Maximum lines to buffer before emitting a batch (mirrors Rust LOG_BATCH_SIZE). */
const LOG_BATCH_SIZE = 20;
/** Maximum time (ms) to wait before flushing a partial batch (mirrors Rust LOG_FLUSH_INTERVAL_MS). */
const LOG_FLUSH_INTERVAL_MS = 50;

/**
 * One active logical stream = N underlying abortable per-pod readers. The Rust
 * kept a single global active slot; we do the same with one module-level
 * session object. `epoch` guards against stale callbacks emitting after stop.
 */
interface LogSession {
  epoch: number;
  controllers: AbortController[];
}

let activeSession: LogSession | null = null;
let epochCounter = 0;

/** Coerce an optional renderer arg to a string, treating null/'' as absent. */
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Coerce an optional renderer numeric arg, treating null/undefined as absent. */
function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Coerce an optional renderer boolean arg, treating null/undefined as absent. */
function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Build the @kubernetes/client-node Log options from the common optional fields.
 * Mirrors the Rust build_log_params: follow is always true; the rest are only
 * set when present.
 */
function buildLogOptions(args: Record<string, unknown>): {
  follow: true;
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  timestamps?: boolean;
  previous?: boolean;
} {
  const opts: ReturnType<typeof buildLogOptions> = { follow: true };
  const tailLines = optNum(args.tailLines);
  if (tailLines !== undefined) opts.tailLines = tailLines;
  const sinceSeconds = optNum(args.sinceSeconds);
  if (sinceSeconds !== undefined) opts.sinceSeconds = sinceSeconds;
  const timestamps = optBool(args.timestamps);
  if (timestamps !== undefined) opts.timestamps = timestamps;
  const previous = optBool(args.previous);
  if (previous !== undefined) opts.previous = previous;
  return opts;
}

/**
 * A Writable sink that splits the raw byte stream on newlines, batches complete
 * lines, and flushes them as string[] via ctx.emit. Mirrors the Rust
 * spawn_log_reader: coalesce on a batch-size cap OR a short debounce timer, and
 * (for single-pod streams) emit a trailing "[stream ended]" marker on close.
 *
 * `linePrefix`, when set, prefixes each emitted line with `[prefix] ` (multi).
 */
function makeLineSink(
  ctx: HandlerCtx,
  session: LogSession,
  linePrefix: string | undefined,
): Writable {
  let partial = '';
  let batch: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const isStale = () => activeSession !== session || session.epoch !== epochCounter;

  const clearTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (batch.length === 0) return;
    if (isStale()) {
      batch = [];
      return;
    }
    const out = batch;
    batch = [];
    ctx.emit(LOG_CHANNEL, out);
  };

  const pushLine = (line: string) => {
    const formatted = linePrefix !== undefined ? `[${linePrefix}] ${line}` : line;
    batch.push(formatted);
    if (batch.length >= LOG_BATCH_SIZE) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, LOG_FLUSH_INTERVAL_MS);
    }
  };

  const emitOne = (line: string) => {
    if (isStale()) return;
    ctx.emit(LOG_CHANNEL, [linePrefix !== undefined ? `[${linePrefix}] ${line}` : line]);
  };

  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      partial += chunk.toString('utf8');
      let idx = partial.indexOf('\n');
      while (idx !== -1) {
        // Strip the trailing '\n' (and a preceding '\r' if present) — the
        // renderer expects complete lines with no trailing newline.
        let line = partial.slice(0, idx);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        pushLine(line);
        partial = partial.slice(idx + 1);
        idx = partial.indexOf('\n');
      }
      cb();
    },
    final(cb) {
      // Flush any buffered complete lines plus a trailing partial line (no
      // newline terminator from the server, e.g. last line of a non-follow log).
      if (partial.length > 0) {
        pushLine(partial);
        partial = '';
      }
      flush();
      // Single-pod streams emit a "[stream ended]" marker (Rust line_prefix.is_none()).
      if (linePrefix === undefined) {
        emitOne('[stream ended]');
      }
      cb();
    },
  });
}

/** Tear down the active session (abort every underlying reader) and clear state. */
function stopActive(): void {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  // Bump epoch so any in-flight sink callbacks become stale and stop emitting.
  epochCounter += 1;
  for (const controller of session.controllers) {
    try {
      controller.abort();
    } catch {
      // already aborted / closed — ignore
    }
  }
}

/**
 * Start streaming logs for ONE pod/container. Aborts any prior active stream
 * first (single-slot semantics, like the Rust STOP_FLAG reset). Returns once
 * the stream has been kicked off; lines arrive asynchronously via "log-lines".
 */
async function streamPodLogs(args: Record<string, unknown>, ctx: HandlerCtx): Promise<null> {
  const name = optStr(args.name);
  const namespace = optStr(args.namespace) ?? '';
  const container = optStr(args.container) ?? '';
  if (!name) {
    throw new Error('stream_pod_logs: missing required arg "name"');
  }

  stopActive();
  const session: LogSession = { epoch: ++epochCounter, controllers: [] };
  activeSession = session;

  const log = new Log(kc());
  const sink = makeLineSink(ctx, session, undefined);
  const options = buildLogOptions(args);

  try {
    const controller = await log.log(namespace, name, container, sink, options);
    // If stop arrived while we were awaiting, abort immediately.
    if (activeSession !== session) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      return null;
    }
    session.controllers.push(controller);
  } catch (err) {
    if (activeSession === session) activeSession = null;
    throw new Error(
      `Failed to start log stream for ${namespace}/${name}: ${(err as Error).message ?? String(err)}`,
    );
  }

  return null;
}

/**
 * Stream logs from MULTIPLE pods under one logical stream. Each line is prefixed
 * with `[pod-name] `. A per-pod start failure emits an `[pod] [error: ...]`
 * line and continues with the rest (mirrors the Rust loop), rather than failing
 * the whole command.
 */
async function streamMultiPodLogs(args: Record<string, unknown>, ctx: HandlerCtx): Promise<null> {
  const pods = Array.isArray(args.pods) ? (args.pods as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  const namespace = optStr(args.namespace) ?? '';
  const container = optStr(args.container) ?? '';

  stopActive();
  const session: LogSession = { epoch: ++epochCounter, controllers: [] };
  activeSession = session;

  const log = new Log(kc());
  const options = buildLogOptions(args);

  for (const podName of pods) {
    // Bail out of the loop if a stop/restart raced in between iterations.
    if (activeSession !== session) break;

    const sink = makeLineSink(ctx, session, podName);
    try {
      const controller = await log.log(namespace, podName, container, sink, options);
      if (activeSession !== session) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        break;
      }
      session.controllers.push(controller);
    } catch (err) {
      // Emit the per-pod error line and keep going (Rust: continue).
      if (activeSession === session) {
        ctx.emit(LOG_CHANNEL, [`[${podName}] [error: ${(err as Error).message ?? String(err)}]`]);
      }
    }
  }

  return null;
}

/** Signal the running log stream(s) to stop. Takes NO args (Rust stop_log_stream). */
function stopLogStream(): null {
  stopActive();
  return null;
}

/** Stop the active log stream(s) (renderer reload/crash cleanup — main.ts hooks). */
export function stopAllLogStreams(): void {
  stopActive();
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('stream_pod_logs', (args, ctx) => streamPodLogs(args, ctx));
  handlers.set('stream_multi_pod_logs', (args, ctx) => streamMultiPodLogs(args, ctx));
  handlers.set('stop_log_stream', () => stopLogStream());
}
