import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as net from 'node:net';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { register, stopAllPortForwards, type PortForwardDeps } from './portforward';

interface Emitted {
  channel: string;
  payload: unknown;
}

let emitted: Emitted[] = [];
let handlers: HandlerMap;
let ctx: HandlerCtx;

/** What the fake apiserver answers for the pod, swapped per test. */
let podLookup: () => Promise<{ status?: { phase?: string }; metadata?: { deletionTimestamp?: unknown } }>;
/** What each new port-forward WebSocket does. */
let openForward: () => Promise<unknown>;
let readPodCalls = 0;

const notFound = (): Error => Object.assign(new Error('pods "web-abc" not found'), { code: 404 });

const deps: PortForwardDeps = {
  readPod: () => {
    readPodCalls++;
    return podLookup();
  },
  forwarder: () => ({
    portForward: () => openForward(),
  }),
};

function start(sessionId = 's1'): Promise<unknown> {
  return handlers.get('start_port_forward')!(
    { podName: 'web-abc', namespace: 'default', containerPort: 80, localPort: 0, sessionId },
    ctx,
  );
}

/** Open a TCP connection to the forward and wait until the far side drops it. */
function connectAndWaitClose(port: number): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.on('close', () => resolve());
  });
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
  });
}

beforeEach(() => {
  emitted = [];
  readPodCalls = 0;
  podLookup = () => Promise.resolve({ status: { phase: 'Running' } });
  openForward = () => new Promise(() => {}); // hang: never opens
  handlers = new Map();
  ctx = {
    emit: (channel, payload) => emitted.push({ channel, payload }),
    mainWindow: () => null,
  };
  register(handlers, ctx, deps);
});

afterEach(() => {
  stopAllPortForwards();
});

describe('start_port_forward', () => {
  test('two concurrent starts with the same id: the second rejects and one server listens', async () => {
    let releasePod!: () => void;
    podLookup = () =>
      new Promise((resolve) => {
        releasePod = () => resolve({ status: { phase: 'Running' } });
      });

    const first = start('dup');
    const second = start('dup');
    await expect(second).rejects.toThrow(/already active/);

    releasePod();
    const res = (await first) as { session_id: string; local_port: number };
    expect(res.session_id).toBe('dup');
    expect(await isListening(res.local_port)).toBe(true);
    expect(readPodCalls).toBe(1);
  });

  test('a failed pod lookup frees the session slot', async () => {
    podLookup = () => Promise.reject(notFound());
    await expect(start('gone')).rejects.toThrow(/not found/);

    podLookup = () => Promise.resolve({ status: { phase: 'Running' } });
    const res = (await start('gone')) as { local_port: number };
    expect(await isListening(res.local_port)).toBe(true);
  });

  test('a stop during the pod lookup aborts the start without binding', async () => {
    let releasePod!: () => void;
    podLookup = () =>
      new Promise((resolve) => {
        releasePod = () => resolve({ status: { phase: 'Running' } });
      });
    const pending = start('early');
    await handlers.get('stop_port_forward')!({ sessionId: 'early' }, ctx);
    releasePod();
    await expect(pending).rejects.toThrow(/stopped/);
    expect(emitted).toEqual([]);
  });
});

describe('target pod death', () => {
  test('a connection failing because the pod is gone closes the session once, with a reason', async () => {
    const res = (await start('s1')) as { local_port: number };

    podLookup = () => Promise.reject(notFound());
    openForward = () => Promise.reject(new Error('Unexpected server response: 404'));

    // Two connections fail back to back; only one close event may go out.
    await Promise.all([connectAndWaitClose(res.local_port), connectAndWaitClose(res.local_port)]);
    await settle();

    expect(emitted).toEqual([
      {
        channel: 'port-forward-closed',
        payload: { session_id: 's1', reason: 'pod web-abc was deleted' },
      },
    ]);
    expect(await isListening(res.local_port)).toBe(false);
  });

  test('a pod that reached a terminal phase closes the session', async () => {
    const res = (await start('s1')) as { local_port: number };
    podLookup = () => Promise.resolve({ status: { phase: 'Failed' } });
    openForward = () => Promise.reject(new Error('boom'));

    await connectAndWaitClose(res.local_port);
    await settle();

    expect(emitted).toEqual([
      { channel: 'port-forward-closed', payload: { session_id: 's1', reason: 'pod web-abc failed' } },
    ]);
  });

  test('a connection failure with the pod still running keeps the session up', async () => {
    const res = (await start('s1')) as { local_port: number };
    openForward = () => Promise.reject(new Error('container port not listening'));

    await connectAndWaitClose(res.local_port);
    await settle();

    expect(emitted).toEqual([]);
    expect(await isListening(res.local_port)).toBe(true);
  });

  test('an apiserver error while probing the pod keeps the session up', async () => {
    const res = (await start('s1')) as { local_port: number };
    podLookup = () => Promise.reject(new Error('fetch failed'));
    openForward = () => Promise.reject(new Error('network'));

    await connectAndWaitClose(res.local_port);
    await settle();

    expect(emitted).toEqual([]);
    expect(await isListening(res.local_port)).toBe(true);
  });
});
