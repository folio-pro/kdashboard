import { test, expect, describe, beforeEach, afterEach } from 'bun:test';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { register, stopAllTerminalSessions, type ExecClient } from './terminal';

// A fake Exec whose exec() resolves only when the test says so, to model the
// WebSocket handshake window in which stop/start races happen.

interface FakeSocket {
  closed: boolean;
  close: () => void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

interface PendingExec {
  socket: FakeSocket;
  /** Finish the handshake. */
  open: () => void;
  /** Fire the status callback, as when the remote process exits. */
  exit: () => void;
  /** The stdout sink handed to exec(). */
  stdout: NodeJS.WritableStream;
}

let pending: PendingExec[] = [];
let emitted: Array<{ channel: string; payload: unknown }> = [];
let handlers: HandlerMap;

function fakeExec(): ExecClient {
  return {
    exec: ((...args: unknown[]) => {
      const stdout = args[4] as NodeJS.WritableStream;
      const statusCb = args[8] as (status: unknown) => void;
      const socket: FakeSocket = {
        closed: false,
        close() {
          socket.closed = true;
        },
        onclose: null,
        onerror: null,
      };
      return new Promise((resolve) => {
        pending.push({
          socket,
          open: () => resolve(socket),
          exit: () => statusCb({ status: 'Success' }),
          stdout,
        });
      });
    }) as unknown as ExecClient['exec'],
  };
}

function start(name = 'pod-a'): Promise<unknown> {
  return handlers.get('start_terminal_exec')!({ name, namespace: 'default' });
}

function exits(): number {
  return emitted.filter((e) => e.channel === 'terminal-exit').length;
}

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  pending = [];
  emitted = [];
  handlers = new Map() as HandlerMap;
  const ctx = {
    emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
  } as unknown as HandlerCtx;
  register(handlers, ctx, fakeExec);
});

afterEach(() => {
  stopAllTerminalSessions();
});

describe('terminal session races', () => {
  test('stop during connect closes the late socket and emits nothing', async () => {
    const started = start();
    await handlers.get('stop_terminal_exec')!({});

    pending[0]!.stdout.write('prompt$ ');
    pending[0]!.open();
    await started;
    await tick();

    expect(pending[0]!.socket.closed).toBe(true);
    expect(emitted).toEqual([]);

    // No session was left behind: input goes nowhere, stop emits nothing.
    await handlers.get('stop_terminal_exec')!({});
    expect(emitted).toEqual([]);
  });

  test('overlapping starts keep only the second socket open', async () => {
    const first = start('pod-a');
    const second = start('pod-b');

    pending[1]!.open();
    await second;
    pending[0]!.open();
    await first;

    expect(pending[0]!.socket.closed).toBe(true);
    expect(pending[1]!.socket.closed).toBe(false);

    // The second session is the live one: stopping it closes its socket.
    await handlers.get('stop_terminal_exec')!({});
    expect(pending[1]!.socket.closed).toBe(true);
    expect(exits()).toBe(1);
  });

  test('overlapping starts resolving in order still close the first socket', async () => {
    const first = start('pod-a');
    const second = start('pod-b');

    pending[0]!.open();
    await first;
    pending[1]!.open();
    await second;

    expect(pending[0]!.socket.closed).toBe(true);
    expect(pending[1]!.socket.closed).toBe(false);
  });

  test("a replaced session's status callback does not end the current one", async () => {
    const first = start('pod-a');
    pending[0]!.open();
    await first;

    const second = start('pod-b');
    pending[1]!.open();
    await second;

    // Late exit frame from the replaced session.
    pending[0]!.exit();
    pending[0]!.socket.onclose?.();

    expect(pending[1]!.socket.closed).toBe(false);
    expect(exits()).toBe(0);

    // The current session's own exit still ends it.
    pending[1]!.exit();
    expect(pending[1]!.socket.closed).toBe(true);
    expect(exits()).toBe(1);
  });

  test('output from a live session reaches the renderer', async () => {
    const started = start();
    pending[0]!.open();
    await started;

    pending[0]!.stdout.write('hello');
    await tick();

    expect(emitted).toEqual([{ channel: 'terminal-output', payload: 'hello' }]);
  });
});
