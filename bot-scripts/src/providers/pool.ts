/** Detail requests in flight per provider: enough to reach GitHub's enterprise quota, far below its concurrency limit. */
export const DETAIL_CONCURRENCY = 4;

/**
 * Maps a source with up to `limit` calls of `fn` in flight and yields the
 * results in source order. The source is pulled only as results are consumed,
 * so a listing is never read further ahead than the window. A rejection
 * surfaces where its result would have been yielded; calls already started
 * finish on their own.
 */
export async function* mapInOrder<T, R>(source: AsyncIterable<T> | Iterable<T>, limit: number, fn: (value: T) => Promise<R>): AsyncGenerator<R> {
  const window: Promise<R>[] = [];
  const start = (value: T) => {
    const pending = fn(value);
    pending.catch(() => {}); // the rejection is reported when the result is awaited in order
    window.push(pending);
  };
  for await (const value of source) {
    start(value);
    if (window.length >= limit) yield await window.shift()!;
  }
  while (window.length) yield await window.shift()!;
}
