// Small shared async utilities for the main process.

/**
 * Map `items` through `fn` with at most `limit` promises in flight, preserving
 * input order. Used to bound fan-outs against the apiserver (access reviews,
 * helm secret reads) that would otherwise fire N simultaneous requests.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
