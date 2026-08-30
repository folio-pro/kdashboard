// Small shared async utilities for the main process.

interface CacheEntry<T> {
  at: number;
  promise: Promise<T>;
}

export interface TtlCache<T> {
  /** Returns the cached promise for `key`, or calls `fetch` and caches its result. */
  get(key: string, fetch: () => Promise<T>): Promise<T>;
  /** Drops every entry — call on a context switch. */
  clear(): void;
}

/**
 * TTL-memoized, single-flight cache of promises. Concurrent callers for the
 * same key share one in-flight fetch; a rejected fetch is evicted immediately
 * (identified by reference, so a slower failure can't clobber a fresher
 * success for the same key) so the next call retries instead of waiting out
 * the TTL. Expired entries are swept on the way to a miss rather than kept
 * resident until a context switch — each one can hold a full list response.
 */
export function createTtlCache<T>(ttlMs: number, opts: { maxEntries?: number } = {}): TtlCache<T> {
  const cache = new Map<string, CacheEntry<T>>();

  function get(key: string, fetch: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.promise;
    for (const [k, v] of cache) if (now - v.at >= ttlMs) cache.delete(k);
    if (opts.maxEntries !== undefined) {
      while (cache.size >= opts.maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    const promise = fetch();
    cache.set(key, { at: now, promise });
    promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
  }

  return { get, clear: () => cache.clear() };
}
