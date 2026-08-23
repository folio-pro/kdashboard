// Logs streaming handler.
//
// Commands implemented:
//   - stream_pod_logs        -> streams ONE pod/container
//   - stream_multi_pod_logs  -> streams N pods under ONE logical stream, each
//                               line prefixed with `[pod-name] `
//   - stop_log_stream        -> takes NO args; aborts whatever is streaming
//
// Event channels:
//   "log-lines"
//     PAYLOAD SHAPE: string[]  (a batch of COMPLETE log lines, no trailing
//     newline per line). The renderer (src/lib/components/logs/LogViewer.svelte)
//     does listen<string[]>("log-lines", e => for (line of e.payload) ...), so
//     every emit MUST be a string[].
//   "log-stream-status"
//     PAYLOAD SHAPE: { state: 'ended' | 'error'; message?: string }
//     Emitted at most once per logical stream, when EVERY pod reader in it has
//     settled. A deliberate stop/restart emits nothing — the renderer drove that
//     transition and must not be told the stream died.
//
// Renderer arg keys (source of truth — src/.../log-viewer.ts buildStreamRequest):
//   stream_pod_logs:       { name, namespace, container, tailLines,
//                            sinceSeconds, timestamps, previous }
//   stream_multi_pod_logs: { pods, namespace, container, tailLines,
//                            sinceSeconds, timestamps, previous }
//   (container/previous may be null; sinceSeconds may be null; the renderer
//    sends camelCase tailLines/sinceSeconds.)
//
// Session semantics: there is ONE active logical log stream at a time, held in
// `activeSession`. Starting a new
// stream aborts any prior one. Session identity IS the staleness check — every
// callback compares against `activeSession` before emitting anything.
//
// WHY THIS DOES NOT USE @kubernetes/client-node's Log helper
// ----------------------------------------------------------
// Log.log() does `response.body.pipe(sink)` and hands back only an
// AbortController — the response body itself stays private. Node's pipe()
// forwards NOTHING to the destination when the source dies abnormally: a source
// error emits no 'error', no 'unpipe' and no 'close' on the destination, and
// the sink's final() (which is what produced the "[stream ended]" marker) only
// runs on a graceful end().
//
// So when a followed log stream dropped mid-flight — pod restarted, apiserver
// idle timeout, network blip, credentials expired — the renderer was told
// nothing at all and sat on "Connecting to log stream..." indefinitely. Owning
// the fetch means we observe all three endings (clean EOF, transport error,
// abort) and can report the first two.

import { AddOptionsToSearchParams, type LogOptions } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { apiStream } from '../k8s/api';
import { mapWithConcurrency } from '../util/concurrency';

const LOG_CHANNEL = 'log-lines';
const STATUS_CHANNEL = 'log-stream-status';

/** Maximum lines to buffer before emitting a batch. */
// Longest single line forwarded to the renderer; the rest of the line is
// dropped with a marker. Bounds main-process memory on newline-free output.
const LOG_MAX_LINE_CHARS = 512 * 1024;
const LOG_TRUNCATED_MARKER = ' …[line truncated]';
const LOG_BATCH_SIZE = 20;
/** How many pod log streams are dialled at once for a multi-pod session. */
const MULTI_POD_DIAL_CONCURRENCY = 8;
/** Maximum time (ms) to wait before flushing a partial batch. */
const LOG_FLUSH_INTERVAL_MS = 50;

/** Payload of STATUS_CHANNEL. Mirrors StreamStatus in src/.../log-viewer.ts. */
interface StreamStatus {
  state: 'ended' | 'error';
  message?: string;
}

/**
 * One active logical stream = N underlying abortable per-pod readers. A single
 * module-level session object holds the active slot, and its identity is the
 * staleness check.
 */
interface LogSession {
  controllers: AbortController[];
}

let activeSession: LogSession | null = null;

/** True once this session has been stopped or superseded — emit nothing more. */
function isStale(session: LogSession): boolean {
  return activeSession !== session;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 * Build the log query options from the common optional fields. `follow` is
 * always true; the rest are only set when present.
 */
function buildLogOptions(args: Record<string, unknown>): LogOptions {
  const opts: LogOptions = { follow: true };
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
 * Batches complete log lines and flushes them as string[] over LOG_CHANNEL,
 * coalescing on a batch-size cap OR a short debounce timer. `linePrefix`, when
 * set, prefixes each line with `[prefix] ` (multi-pod streams).
 */
function makeBatcher(ctx: HandlerCtx, session: LogSession, linePrefix: string | undefined) {
  let batch: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const decorate = (line: string): string =>
    linePrefix !== undefined ? `[${linePrefix}] ${line}` : line;

  const clearTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = (): void => {
    clearTimer();
    if (batch.length === 0) return;
    if (isStale(session)) {
      batch = [];
      return;
    }
    const out = batch;
    batch = [];
    ctx.emit(LOG_CHANNEL, out);
  };

  const push = (line: string): void => {
    batch.push(decorate(line));
    if (batch.length >= LOG_BATCH_SIZE) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, LOG_FLUSH_INTERVAL_MS);
    }
  };

  const emitOne = (line: string): void => {
    if (isStale(session)) return;
    ctx.emit(LOG_CHANNEL, [decorate(line)]);
  };

  return { push, flush, emitOne, clearTimer };
}

/**
 * Read a log response body to completion, splitting on newlines and handing
 * whole lines to the batcher. Resolves on clean EOF; rejects on transport error
 * or abort.
 */
async function pumpBody(
  session: LogSession,
  body: ReadableStream<Uint8Array>,
  batcher: ReturnType<typeof makeBatcher>,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let partial = '';
  // True while the rest of an over-long line is being discarded.
  let dropping = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Stop feeding a stream nobody is listening to any more.
      if (isStale(session)) return;
      partial += decoder.decode(value, { stream: true });
      // Split with a moving offset and slice the remainder ONCE per chunk: a
      // `tail` of thousands of lines arrives in big chunks, and re-slicing the
      // remainder after every line copied the chunk once per line (O(n²)).
      let start = 0;
      let idx = partial.indexOf('\n', start);
      while (idx !== -1) {
        if (dropping) {
          dropping = false;
        } else {
          // Strip the trailing '\n' (and a preceding '\r' if present) — the
          // renderer expects complete lines with no trailing newline.
          const end = idx > start && partial.charCodeAt(idx - 1) === 13 ? idx - 1 : idx;
          batcher.push(partial.slice(start, end));
        }
        start = idx + 1;
        idx = partial.indexOf('\n', start);
      }
      partial = start > 0 ? partial.slice(start) : partial;
      // A line with no newline in sight keeps growing in main-process memory
      // (single-line JSON dumps, binary to stdout): cap it, ship what fits with
      // a marker, and skip to the next newline.
      if (!dropping && partial.length > LOG_MAX_LINE_CHARS) {
        batcher.push(partial.slice(0, LOG_MAX_LINE_CHARS) + LOG_TRUNCATED_MARKER);
        partial = '';
        dropping = true;
      } else if (dropping) {
        partial = '';
      }
    }
    // A trailing line with no newline terminator from the server.
    partial += decoder.decode();
    if (partial.length > 0 && !dropping) batcher.push(partial);
  } finally {
    reader.releaseLock();
    // In the `finally` so a mid-stream failure still delivers what was already
    // buffered: push() only arms a 50ms debounce, and the caller's rejection
    // path clears that timer, so anything batched within the last 50ms of a
    // dropped stream would otherwise be discarded — exactly the lines before a
    // crash that are worth reading.
    batcher.flush();
  }
}

/**
 * Open ONE pod's log stream. Awaits only until the response headers arrive, so
 * the caller's command resolves on a real connection; `drained` then settles
 * whenever that pod's stream finishes, cleanly or otherwise.
 */
async function openStream(
  ctx: HandlerCtx,
  session: LogSession,
  namespace: string,
  podName: string,
  container: string,
  args: Record<string, unknown>,
  linePrefix: string | undefined,
): Promise<{ drained: Promise<void> }> {
  const controller = new AbortController();
  const query = new URLSearchParams();
  query.set('container', container);
  AddOptionsToSearchParams(buildLogOptions(args), query);

  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log`;
  const resp = await apiStream(path, query, controller.signal);

  // A stop/restart raced the connect: drop it. There is no reader to wait on,
  // and the session is already stale so nothing will be reported for it.
  if (isStale(session)) {
    controller.abort();
    void resp.body?.cancel().catch(() => {});
    return { drained: Promise.resolve() };
  }

  // Treated as a connect failure rather than a rejected `drained`: an eagerly
  // rejected promise would be unhandled until allSettled attaches to it.
  if (!resp.body) {
    controller.abort();
    throw new Error('empty log response');
  }

  session.controllers.push(controller);
  const batcher = makeBatcher(ctx, session, linePrefix);

  // Deliberately NOT awaited — see the doc comment above.
  const drained = pumpBody(session, resp.body, batcher).then(
    () => {
      batcher.clearTimer();
      // Only single-pod streams emit the "[stream ended]" marker.
      if (linePrefix === undefined) batcher.emitOne('[stream ended]');
    },
    (err: unknown) => {
      batcher.clearTimer();
      batcher.emitOne(`[error: ${messageOf(err)}]`);
      // Rethrow so the session's terminal status sees this reader as failed.
      throw err;
    },
  );

  return { drained };
}

/**
 * Emit the session's single terminal status once EVERY reader has settled.
 *
 * Waiting for all of them is what keeps a multi-pod stream honest: readers are
 * dialled one after another, so any "are we done yet" counter would see zero
 * live readers in the gap between one pod finishing and the next connecting,
 * and would end the session early. Likewise one pod dropping is not the whole
 * session failing while its siblings are still streaming.
 */
function reportWhenDrained(
  ctx: HandlerCtx,
  session: LogSession,
  drains: Array<Promise<void>>,
): void {
  void Promise.allSettled(drains).then((results) => {
    if (isStale(session)) return;
    const failure = results.find((r) => r.status === 'rejected');
    const status: StreamStatus = failure
      ? { state: 'error', message: messageOf(failure.reason) }
      : { state: 'ended' };
    ctx.emit(STATUS_CHANNEL, status);
  });
}

/** Tear down the active session (abort every underlying reader) and clear state. */
function stopActive(): void {
  if (!activeSession) return;
  const session = activeSession;
  // Clear FIRST: every callback checks identity, so this is what makes the
  // whole session stale before we start aborting.
  activeSession = null;
  for (const controller of session.controllers) {
    try {
      controller.abort();
    } catch {
      // already aborted / closed — ignore
    }
  }
}

/** Replace whatever is streaming with a fresh single-slot session. */
function beginSession(): LogSession {
  stopActive();
  const session: LogSession = { controllers: [] };
  activeSession = session;
  return session;
}

/**
 * Start streaming logs for ONE pod/container. Aborts any prior active stream
 * first (single-slot semantics). Resolves once the stream is established;
 * lines arrive asynchronously via "log-lines".
 */
async function streamPodLogs(args: Record<string, unknown>, ctx: HandlerCtx): Promise<null> {
  const name = optStr(args.name);
  const namespace = optStr(args.namespace) ?? '';
  const container = optStr(args.container) ?? '';
  if (!name) {
    throw new Error('stream_pod_logs: missing required arg "name"');
  }

  const session = beginSession();

  let drained: Promise<void>;
  try {
    ({ drained } = await openStream(ctx, session, namespace, name, container, args, undefined));
  } catch (err) {
    if (activeSession === session) activeSession = null;
    throw new Error(`Failed to start log stream for ${namespace}/${name}: ${messageOf(err)}`);
  }

  reportWhenDrained(ctx, session, [drained]);
  return null;
}

/**
 * Stream logs from MULTIPLE pods under one logical stream. Each line is prefixed
 * with `[pod-name] `. A per-pod start failure emits an `[pod] [error: ...]`
 * line and continues with the rest, rather than failing the whole command.
 */
async function streamMultiPodLogs(args: Record<string, unknown>, ctx: HandlerCtx): Promise<null> {
  const pods = Array.isArray(args.pods)
    ? (args.pods as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const namespace = optStr(args.namespace) ?? '';
  const container = optStr(args.container) ?? '';

  const session = beginSession();
  const drains: Array<Promise<void>> = [];

  // Dial pods concurrently (bounded): serially, 30 pods meant 30 round-trips
  // before the last one showed a line. Order of the error lines follows
  // completion order, which is fine — each carries its pod name.
  const dial = async (podName: string): Promise<void> => {
    // Bail out if a stop/restart raced in.
    if (isStale(session)) return;
    try {
      const { drained } = await openStream(ctx, session, namespace, podName, container, args, podName);
      // Attach a no-op handler NOW: reportWhenDrained only subscribes once
      // every pod has been dialled, and a reader that dies in the gap would be
      // an unhandled rejection — fatal to the main process under Node's
      // default --unhandled-rejections=throw. allSettled still sees the
      // original rejection.
      void drained.catch(() => {});
      drains.push(drained);
    } catch (err) {
      // Emit the per-pod error line and keep going.
      if (!isStale(session)) {
        ctx.emit(LOG_CHANNEL, [`[${podName}] [error: ${messageOf(err)}]`]);
      }
    }
  };
  await mapWithConcurrency(pods, MULTI_POD_DIAL_CONCURRENCY, dial);

  if (isStale(session)) return null;

  if (drains.length === 0) {
    // Nothing will ever drain, so report now rather than leaving the renderer
    // waiting on a stream that never was.
    ctx.emit(STATUS_CHANNEL, {
      state: 'error',
      message: pods.length === 0 ? 'No pods to stream' : 'No pod log streams could be started',
    } satisfies StreamStatus);
    return null;
  }

  reportWhenDrained(ctx, session, drains);
  return null;
}

/** Signal the running log stream(s) to stop. Takes NO args. */
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
