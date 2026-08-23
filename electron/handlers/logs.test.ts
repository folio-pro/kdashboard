import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

import type { HandlerCtx, HandlerMap } from '../dispatch';

// The handler talks to the cluster through apiStream; stub it so these tests
// exercise the streaming state machine (batching, epoch guards, terminal
// status) rather than the network.
/** Responses staged for upcoming apiStream calls, consumed in order. */
let responseQueue: Array<() => Promise<Response>> = [];

mock.module('../k8s/api', () => ({
  META_ACCEPT: 'application/json',
  apiGet: () => Promise.reject(new Error('not used')),
  apiStream: (_path: string, _query: URLSearchParams, signal: AbortSignal) => {
    const next = responseQueue.shift();
    if (!next) throw new Error('test did not stage a response');
    return next().then((resp) => {
      // Mimic fetch: aborting the signal tears the body down.
      signal.addEventListener('abort', () => {
        void resp.body?.cancel().catch(() => {});
      });
      return resp;
    });
  },
}));

const { register, stopAllLogStreams } = await import('./logs');

interface Emitted {
  channel: string;
  payload: unknown;
}

let emitted: Emitted[] = [];
let handlers: HandlerMap;
let ctx: HandlerCtx;

/**
 * Stage a Response whose body is a stream this test drives by hand. `connectMs`
 * delays the connect itself, to model one pod still dialling while another is
 * already streaming.
 */
function stagedBody(connectMs = 0): {
  push: (chunk: string) => void;
  close: () => void;
  fail: (err: Error) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  responseQueue.push(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response(body, { status: 200 })), connectMs),
      ),
  );
  return {
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    fail: (err: Error) => controller.error(err),
  };
}

/** Stage a connect that fails. */
function stagedFailure(message: string, times = 1): void {
  for (let i = 0; i < times; i++) {
    responseQueue.push(() => Promise.reject(new Error(message)));
  }
}

/** Give the handler's background pump a chance to drain and flush (50ms debounce). */
function settle(ms = 90): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lines(): string[] {
  return emitted.filter((e) => e.channel === 'log-lines').flatMap((e) => e.payload as string[]);
}

function statuses(): Array<{ state: string; message?: string }> {
  return emitted
    .filter((e) => e.channel === 'log-stream-status')
    .map((e) => e.payload as { state: string; message?: string });
}

beforeEach(() => {
  emitted = [];
  handlers = new Map();
  ctx = { emit: (channel, payload) => emitted.push({ channel, payload }) } as HandlerCtx;
  register(handlers, ctx);
});

afterEach(() => {
  stopAllLogStreams();
  responseQueue = [];
});

describe('stream_pod_logs', () => {
  test('emits complete lines and strips the newline terminators', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('hello\nworld\r\n');
    await settle();

    expect(lines()).toEqual(['hello', 'world']);
  });

  test('holds back a partial line until its newline arrives', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('half');
    await settle();
    expect(lines()).toEqual([]);

    body.push('-and-half\n');
    await settle();
    expect(lines()).toEqual(['half-and-half']);
  });

  test('many lines in one chunk come out in order, CR stripped', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    const chunk = Array.from({ length: 50 }, (_, i) => `line-${i}${i % 2 ? '\r' : ''}\n`).join('');
    body.push(chunk + 'tail');
    await settle();

    expect(lines()).toEqual(Array.from({ length: 50 }, (_, i) => `line-${i}`));
    body.push('-end\n');
    await settle();
    expect(lines().at(-1)).toBe('tail-end');
  });

  test('a newline-free line past the cap is truncated and the rest dropped', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    // 600 KiB without a newline, in 100 KiB chunks, then a normal line.
    for (let i = 0; i < 6; i++) body.push('x'.repeat(100 * 1024));
    body.push('still-the-same-line\nnext\n');
    await settle();

    const out = lines();
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(512 * 1024 + ' …[line truncated]'.length);
    expect(out[0].endsWith(' …[line truncated]')).toBe(true);
    expect(out[1]).toBe('next');
  });

  // A clean end already worked before; the marker and status must both fire.
  test('a graceful end emits the [stream ended] marker and an ended status', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('only line\n');
    body.close();
    await settle();

    expect(lines()).toEqual(['only line', '[stream ended]']);
    expect(statuses()).toEqual([{ state: 'ended' }]);
  });

  test('a trailing line with no newline is still emitted at EOF', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('no trailing newline');
    body.close();
    await settle();

    expect(lines()).toEqual(['no trailing newline', '[stream ended]']);
  });

  // THE REGRESSION: a stream that dies mid-flight used to tell the renderer
  // nothing at all, leaving it stuck on "Connecting to log stream...".
  test('a transport error reports an error status instead of going silent', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('before the drop\n');
    await settle();
    body.fail(new Error('connection reset by peer'));
    await settle();

    expect(lines()).toContain('before the drop');
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0].state).toBe('error');
    expect(statuses()[0].message).toContain('connection reset by peer');
  });

  // The lines just before a crash are the ones worth reading. A drop inside the
  // batch debounce window must not take them with it.
  test('lines still buffered when the stream drops are delivered, then the error', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('last words\n');
    // Long enough for the pump to buffer the line, shorter than the 50ms flush
    // debounce, so the batch is still unflushed when the stream dies.
    await settle(10);
    body.fail(new Error('econnreset'));
    await settle();

    expect(lines()).toEqual(['last words', '[error: econnreset]']);
  });

  test('rejects when the required name arg is missing', async () => {
    stagedBody();
    await expect(handlers.get('stream_pod_logs')!({ namespace: 'default' }, ctx)).rejects.toThrow(
      /missing required arg "name"/,
    );
  });

  test('wraps a connect failure with the pod coordinates', async () => {
    stagedFailure('403 Forbidden');
    await expect(
      handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'kube-system' }, ctx),
    ).rejects.toThrow(/Failed to start log stream for kube-system\/web-0: 403 Forbidden/);
  });
});

describe('stop_log_stream', () => {
  // A deliberate stop is a transition the renderer already knows about; telling
  // it the stream "errored" would flip the viewer into a false failure state.
  test('stopping emits no terminal status and silences later output', async () => {
    const body = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);

    body.push('before stop\n');
    await settle();
    handlers.get('stop_log_stream')!({}, ctx);

    body.push('after stop\n');
    body.fail(new Error('aborted'));
    await settle();

    expect(lines()).toEqual(['before stop']);
    expect(statuses()).toEqual([]);
  });

  test('restarting supersedes the previous stream without a status', async () => {
    const first = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-0', namespace: 'default' }, ctx);
    first.push('from first\n');
    await settle();

    const second = stagedBody();
    await handlers.get('stream_pod_logs')!({ name: 'web-1', namespace: 'default' }, ctx);

    // The superseded stream must not be able to emit anything more.
    first.push('late from first\n');
    first.fail(new Error('aborted'));
    second.push('from second\n');
    await settle();

    expect(lines()).toEqual(['from first', 'from second']);
    expect(statuses()).toEqual([]);
  });
});

describe('stream_multi_pod_logs', () => {
  test('prefixes each line with its pod name', async () => {
    const body = stagedBody();
    await handlers.get('stream_multi_pod_logs')!({ pods: ['web-a'], namespace: 'default' }, ctx);

    body.push('hello\n');
    await settle();

    expect(lines()).toEqual(['[web-a] hello']);
  });

  test('reports an error status when no pod stream could be started', async () => {
    stagedFailure('404 Not Found', 2);
    await handlers.get('stream_multi_pod_logs')!(
      { pods: ['gone-a', 'gone-b'], namespace: 'default' },
      ctx,
    );

    expect(lines()).toEqual(['[gone-a] [error: 404 Not Found]', '[gone-b] [error: 404 Not Found]']);
    expect(statuses()).toEqual([{ state: 'error', message: 'No pod log streams could be started' }]);
  });

  test('an empty pod list reports rather than hanging', async () => {
    await handlers.get('stream_multi_pod_logs')!({ pods: [], namespace: 'default' }, ctx);
    expect(statuses()).toEqual([{ state: 'error', message: 'No pods to stream' }]);
  });

  // Pods are dialled one after another, so the reader count legitimately sits at
  // zero between "the first pod's stream finished" and "the second pod connected".
  // Reporting the session as ended there would blank a viewer that is about to
  // receive the rest of the pods' output.
  test('one pod finishing while another is still connecting is not an ended session', async () => {
    const a = stagedBody();
    const b = stagedBody(60);

    const pending = handlers.get('stream_multi_pod_logs')!(
      { pods: ['pod-a', 'pod-b'], namespace: 'default' },
      ctx,
    );

    // pod-a is streaming; pod-b is still dialling.
    await settle(15);
    a.push('from a\n');
    a.close();
    await settle(25);

    expect(statuses()).toEqual([]);

    await pending;
    b.push('from b\n');
    await settle();

    expect(lines()).toEqual(['[pod-a] from a', '[pod-b] from b']);
    expect(statuses()).toEqual([]);
  });

  // reportWhenDrained only subscribes to the drain promises once the whole loop
  // has finished dialling. A reader that dies inside that window therefore has
  // no handler attached yet, which under Node's default
  // --unhandled-rejections=throw takes the main process down with it.
  test('a pod dropping while another is still connecting is not an unhandled rejection', async () => {
    const a = stagedBody();
    const b = stagedBody(60);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const pending = handlers.get('stream_multi_pod_logs')!(
        { pods: ['pod-a', 'pod-b'], namespace: 'default' },
        ctx,
      );

      // pod-a's transport dies while pod-b is still dialling.
      await settle(15);
      a.fail(new Error('econnreset'));
      await settle(25);

      await pending;
      b.push('from b\n');
      await settle();

      expect(rejections).toEqual([]);
      // The failure is still reported — swallowing the rejection must not
      // swallow the reader's outcome.
      expect(lines()).toContain('[pod-a] [error: econnreset]');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // One pod dropping is not the session failing while its siblings still stream.
  test('one pod erroring does not end the session while another still streams', async () => {
    const a = stagedBody();
    const b = stagedBody();
    await handlers.get('stream_multi_pod_logs')!(
      { pods: ['pod-a', 'pod-b'], namespace: 'default' },
      ctx,
    );

    a.fail(new Error('econnreset'));
    await settle();

    // The failure is visible as a line, but the session is still live.
    expect(lines()).toContain('[pod-a] [error: econnreset]');
    expect(statuses()).toEqual([]);

    b.push('still going\n');
    await settle();
    expect(lines()).toContain('[pod-b] still going');
    expect(statuses()).toEqual([]);
  });

  test('a pod failure surfaces once every pod has settled', async () => {
    const a = stagedBody();
    const b = stagedBody();
    await handlers.get('stream_multi_pod_logs')!(
      { pods: ['pod-a', 'pod-b'], namespace: 'default' },
      ctx,
    );

    a.fail(new Error('econnreset'));
    b.close();
    await settle();

    expect(statuses()).toEqual([{ state: 'error', message: 'econnreset' }]);
  });

  test('reports ended once every pod stream has drained', async () => {
    const a = stagedBody();
    const b = stagedBody();
    await handlers.get('stream_multi_pod_logs')!(
      { pods: ['pod-a', 'pod-b'], namespace: 'default' },
      ctx,
    );

    a.close();
    await settle();
    expect(statuses()).toEqual([]);

    b.close();
    await settle();
    expect(statuses()).toEqual([{ state: 'ended' }]);
  });
});
