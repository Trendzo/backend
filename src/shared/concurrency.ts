/**
 * Run an async mapper over items with a bounded number of concurrent calls,
 * preserving input order in the returned array. Used to cap how many image-gen
 * requests hit the provider at once: Vertex's Dynamic Shared Quota returns 429
 * on bursts, so firing every angle in parallel trips the limit. A small cap
 * (e.g. 2) smooths traffic while keeping generation reasonably fast.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
