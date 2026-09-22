import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Watch } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import type { CrdInfo } from './crd';

// The watch loop reads the active KubeConfig (kc() cannot be built under Bun —
// it installs an undici dispatcher) and seeds fresh RVs through apiGet. Stub
// both so the loop runs against a fake apiserver; Watch.prototype.watch is
// spied per test below.
const realClient = await import('../k8s/client');
const realApi = await import('../k8s/api');
const fakeKc = {
  getCurrentContext: () => 'test',
  getCurrentCluster: () => ({ name: 'test', server: 'https://fake.invalid:6443' }),
};
/** What the seedRV metadata list answers; null = the list fails. */
let seedListRV: string | null = null;
mock.module('../k8s/client', () => ({
  ...realClient,
  kc: () => fakeKc,
  getActiveContextName: () => 'test',
}));
mock.module('../k8s/api', () => ({
  ...realApi,
  apiGet: async () => {
    if (seedListRV === null) throw new Error('seed list unavailable');
    return { metadata: { resourceVersion: seedListRV } };
  },
}));

const { describeWatchEnd, register, resolveWatchTarget, stopAllWatches, watchPath } = await import('./watch');

const widget: CrdInfo = {
  group: 'demo.kdash.io',
  version: 'v1alpha1',
  kind: 'Widget',
  plural: 'widgets',
  scope: 'Namespaced',
  short_names: ['wd'],
};
const gadget: CrdInfo = { ...widget, kind: 'Gadget', plural: 'gadgets', scope: 'Cluster' };

const discovery = async (group: string, kind: string): Promise<CrdInfo | undefined> =>
  [widget, gadget].find((c) => c.group === group && c.kind === kind);

describe('resolveWatchTarget — what a watch resource_type maps to', () => {
  test('built-in kinds come from the registry, without touching discovery', async () => {
    const fail = async (): Promise<CrdInfo | undefined> => {
      throw new Error('discovery must not run for a built-in kind');
    };
    const pods = await resolveWatchTarget('pods', fail);
    expect(pods).toEqual({ group: '', version: 'v1', apiVersion: 'v1', kind: 'Pod', plural: 'pods', clusterScoped: false });
    const nodes = await resolveWatchTarget('nodes', fail);
    expect(nodes?.clusterScoped).toBe(true);
  });

  test('a crd:<group>/<Kind> pseudo-type resolves through CRD discovery', async () => {
    const ar = await resolveWatchTarget('crd:demo.kdash.io/Widget', discovery);
    expect(ar).toEqual({
      group: 'demo.kdash.io',
      version: 'v1alpha1',
      apiVersion: 'demo.kdash.io/v1alpha1',
      kind: 'Widget',
      plural: 'widgets',
      clusterScoped: false,
    });
    const cluster = await resolveWatchTarget('crd:demo.kdash.io/Gadget', discovery);
    expect(cluster?.clusterScoped).toBe(true);
  });

  test('unknown built-ins and undiscovered CRDs are undefined (the start rejects)', async () => {
    expect(await resolveWatchTarget('gizmos', discovery)).toBeUndefined();
    expect(await resolveWatchTarget('crd:demo.kdash.io/Nope', discovery)).toBeUndefined();
    expect(await resolveWatchTarget('crd:malformed', discovery)).toBeUndefined();
  });
});

describe('watchPath — where the watch connects', () => {
  test('a namespaced CRD watches its namespace, or the whole cluster with none', async () => {
    const ar = (await resolveWatchTarget('crd:demo.kdash.io/Widget', discovery))!;
    expect(watchPath(ar, 'team-a')).toBe('/apis/demo.kdash.io/v1alpha1/namespaces/team-a/widgets');
    expect(watchPath(ar, undefined)).toBe('/apis/demo.kdash.io/v1alpha1/widgets');
    expect(watchPath(ar, '')).toBe('/apis/demo.kdash.io/v1alpha1/widgets');
  });

  test('a cluster-scoped kind ignores the namespace', async () => {
    const ar = (await resolveWatchTarget('nodes'))!;
    expect(watchPath(ar, 'default')).toBe('/api/v1/nodes');
  });
});

describe('describeWatchEnd — which stream ends the renderer hears about', () => {
  test('a clean close and our own abort are silent', () => {
    expect(describeWatchEnd(null)).toBeNull();
    expect(describeWatchEnd(undefined)).toBeNull();
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(describeWatchEnd(abort)).toBeNull();
    expect(describeWatchEnd(new Error('The user aborted a request.'))).toBeNull();
  });

  test('a transport failure is reported with its network hint', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), { code: 'ECONNREFUSED' });
    const msg = describeWatchEnd(refused);
    expect(msg).toContain('Cannot reach');
    expect(msg).toContain('[ECONNREFUSED]');
  });

  test('an apiserver status error keeps its message', () => {
    expect(describeWatchEnd(new Error('Service Unavailable'))).toBe('Service Unavailable');
  });
});

// ---------------------------------------------------------------------------
// HTTP 410 Gone at connect. client-node's Watch.watch() never rejects on a
// non-200 status: it calls done(err) with err.statusCode set, then RESOLVES
// with the controller. The fake below mimics exactly that.
// ---------------------------------------------------------------------------

type DoneFn = (err: unknown) => void;
interface WatchCall {
  query: Record<string, unknown>;
  done: DoneFn;
}
/** How the next connects answer, consumed in order; 'open' once exhausted. */
type Outcome = 'open' | 'gone';

describe('start_resource_watch — HTTP 410 Gone at connect', () => {
  let emitted: unknown[];
  let handlers: HandlerMap;
  let ctx: HandlerCtx;
  let calls: WatchCall[];
  let outcomes: Outcome[];
  let watchSpy: ReturnType<typeof spyOn>;

  const gone = (): Error => Object.assign(new Error('Gone'), { statusCode: 410 });
  const resyncs = (): number =>
    emitted.filter((e) => (e as { event_type?: string }).event_type === 'Resync').length;
  const errors = (): unknown[] =>
    emitted.filter((e) => (e as { event_type?: string }).event_type === 'watch_error');

  async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the watch loop');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  beforeEach(() => {
    emitted = [];
    calls = [];
    outcomes = [];
    seedListRV = null;
    handlers = new Map();
    ctx = {
      emit: (_channel: string, payload: unknown) => emitted.push(...(payload as unknown[])),
    } as HandlerCtx;
    register(handlers, ctx);
    watchSpy = spyOn(Watch.prototype, 'watch').mockImplementation((async (
      _path: string,
      query: Record<string, unknown>,
      _cb: unknown,
      done: DoneFn,
    ) => {
      calls.push({ query: { ...query }, done });
      const controller = new AbortController();
      if ((outcomes.shift() ?? 'open') === 'gone') {
        controller.abort();
        done(gone());
      }
      return controller;
    }) as never);
  });

  afterEach(() => {
    stopAllWatches();
    watchSpy.mockRestore();
  });

  const start = (resourceVersion?: string): Promise<unknown> =>
    Promise.resolve(handlers.get('start_resource_watch')!({ resourceType: 'pods', resourceVersion }, ctx));

  test('a reconnect that 410s drops the expired RV, resyncs once, and reconnects without it', async () => {
    await start('100');
    expect(calls[0].query.resourceVersion).toBe('100');

    // Routine server close: resumable, so the reconnect keeps the RV — and 410s.
    outcomes.push('gone');
    calls[0].done(null);
    await waitFor(() => calls.length >= 3);

    expect(calls[1].query.resourceVersion).toBe('100');
    // Seed list failed: the retry replays from scratch instead of re-sending
    // the expired RV forever.
    expect(calls[2].query.resourceVersion).toBeUndefined();
    expect(resyncs()).toBe(1);
    expect(errors()).toEqual([]);
  });

  test('the retry after a 410 resumes from a freshly seeded RV when the list answers', async () => {
    await start('100');
    seedListRV = '500';
    outcomes.push('gone');
    calls[0].done(null);
    await waitFor(() => calls.length >= 3);

    expect(calls[2].query.resourceVersion).toBe('500');
    expect(resyncs()).toBe(1);
  });

  test('a stale renderer RV that 410s on the first open still starts the watch', async () => {
    outcomes.push('gone');
    seedListRV = '900';
    await start('1');

    expect(calls.map((c) => c.query.resourceVersion)).toEqual(['1', '900']);
    expect(resyncs()).toBe(1);
    expect(errors()).toEqual([]);
  });

  test('a 410 without any RV sent is not an expired RV: the first open still rejects', async () => {
    outcomes.push('gone');
    await expect(start(undefined)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(resyncs()).toBe(0);
  });
});
