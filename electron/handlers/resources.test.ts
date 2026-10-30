import { test, expect, describe, beforeEach, mock } from 'bun:test';

// listRaw talks to the cluster through apiGet; stub it so these tests drive the
// pagination loop (continue tokens, 410 restarts) rather than the network.
interface Call {
  path: string;
  query: Record<string, string>;
}
let calls: Call[] = [];
/** Replies for upcoming apiGet calls, consumed in order. */
let replies: Array<() => unknown> = [];

/** The error apiGet throws for a non-2xx response. */
function httpError(status: number, statusText: string, body: unknown): Error {
  return Object.assign(new Error(`${status} ${statusText}: ${JSON.stringify(body)}`), { status });
}

const EXPIRED = httpError(410, 'Gone', {
  kind: 'Status',
  apiVersion: 'v1',
  status: 'Failure',
  message:
    'The provided continue parameter is too old to display a consistent list result. You can start a new list without the continue parameter, or use the continue token in this response to retrieve the remainder of the results. Continuing with the provided token results in an inconsistent list - objects that were created, modified, or deleted between the time the first chunk was returned and now may show up in the list.',
  reason: 'Expired',
  code: 410,
  metadata: { continue: 'inconsistent-token' },
});

mock.module('../k8s/api', () => ({
  META_ACCEPT: 'application/json',
  apiGet: (path: string, query: Record<string, string> = {}) => {
    calls.push({ path, query: { ...query } });
    const next = replies.shift();
    if (!next) return Promise.reject(new Error('test did not stage a reply'));
    try {
      return Promise.resolve(next());
    } catch (err) {
      return Promise.reject(err);
    }
  },
  apiStream: () => Promise.reject(new Error('not used')),
}));

const { listRaw } = await import('./resources');

const PODS = { group: '', version: 'v1', apiVersion: 'v1', plural: 'pods', clusterScoped: false };

function page(names: string[], resourceVersion: string, cont?: string): () => unknown {
  return () => ({
    items: names.map((name) => ({ metadata: { name } })),
    metadata: { resourceVersion, ...(cont ? { continue: cont } : {}) },
  });
}

function fail(err: Error): () => unknown {
  return () => {
    throw err;
  };
}

const names = (items: Array<{ metadata?: { name?: string } }>) => items.map((i) => i.metadata?.name);

beforeEach(() => {
  calls = [];
  replies = [];
});

describe('listRaw pagination', () => {
  test('follows continue tokens across pages', async () => {
    replies.push(page(['a', 'b'], '100', 'tok1'), page(['c'], '100'));
    const res = await listRaw({ ar: PODS, namespace: 'default' });
    expect(names(res.items)).toEqual(['a', 'b', 'c']);
    expect(res.resourceVersion).toBe('100');
    expect(calls.map((c) => c.query.continue)).toEqual([undefined, 'tok1']);
  });

  test('restarts from page one when the continue token expires (410)', async () => {
    replies.push(
      page(['a', 'b'], '100', 'tok1'),
      fail(EXPIRED),
      // Fresh list: a snapshot at a newer RV, 'b' deleted and 'd' created meanwhile.
      page(['a', 'c'], '200', 'tok2'),
      page(['d'], '200'),
    );
    const res = await listRaw({ ar: PODS, namespace: 'default' });
    // Items from the abandoned pass are discarded — no duplicates, no stale 'b'.
    expect(names(res.items)).toEqual(['a', 'c', 'd']);
    // The watch resumes from the snapshot actually returned, not the stale one.
    expect(res.resourceVersion).toBe('200');
    expect(calls.map((c) => c.query.continue)).toEqual([undefined, 'tok1', undefined, 'tok2']);
    // The restart keeps the page size and selector.
    expect(calls[2].query.limit).toBe('500');
  });

  test('keeps the label selector on the restarted list', async () => {
    replies.push(page(['a'], '1', 'tok1'), fail(EXPIRED), page(['a'], '2'));
    await listRaw({ ar: PODS, namespace: 'default', labelSelector: 'app=web' });
    expect(calls.every((c) => c.query.labelSelector === 'app=web')).toBe(true);
  });

  test('repeated expiry surfaces a clear, actionable error', async () => {
    replies.push(
      page(['a'], '1', 'tok1'),
      fail(EXPIRED),
      page(['a'], '2', 'tok2'),
      fail(EXPIRED),
    );
    const err = await listRaw({ ar: PODS, namespace: 'default' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/changed too fast to page through/);
    expect(err!.message).toMatch(/retry/i);
    // Bounded: no third pass.
    expect(calls).toHaveLength(4);
  });

  test('a 410 on the first page (no continue token) is not retried', async () => {
    const gone = httpError(410, 'Gone', { kind: 'Status', code: 410, reason: 'Gone' });
    replies.push(fail(gone));
    await expect(listRaw({ ar: PODS, namespace: 'default' })).rejects.toBe(gone);
    expect(calls).toHaveLength(1);
  });

  test('other errors mid-pagination propagate unchanged', async () => {
    const boom = httpError(500, 'Internal Server Error', { kind: 'Status', code: 500 });
    replies.push(page(['a'], '1', 'tok1'), fail(boom));
    await expect(listRaw({ ar: PODS, namespace: 'default' })).rejects.toBe(boom);
    expect(calls).toHaveLength(2);
  });
});
