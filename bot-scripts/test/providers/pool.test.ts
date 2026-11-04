import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapInOrder } from '../../src/providers/pool.ts';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/** A call whose completion the test controls. */
function gate<T>() {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { release = resolve; fail = reject; });
  return { promise, release, fail };
}

test('yields results in source order with at most the limit in flight', async () => {
  const gates = new Map<number, ReturnType<typeof gate<string>>>();
  let inFlight = 0;
  let peak = 0;
  const fn = (n: number) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    const g = gate<string>(); gates.set(n, g);
    return g.promise.finally(() => { inFlight -= 1; });
  };
  const out: string[] = [];
  const done = (async () => { for await (const v of mapInOrder([1, 2, 3, 4, 5, 6], 3, fn)) out.push(v); })();
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 3);
  assert.deepEqual([...gates.keys()], [1, 2, 3]);
  gates.get(2)!.release('two'); // out of order completion changes nothing for the consumer
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, []);
  gates.get(1)!.release('one');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ['one', 'two']);
  assert.equal(peak, 3, 'the window refills only as results are consumed');
  for (const n of [3, 4, 5, 6]) { await new Promise((r) => setImmediate(r)); gates.get(n)!.release(String(n)); }
  await done;
  assert.deepEqual(out, ['one', 'two', '3', '4', '5', '6']);
  assert.equal(peak, 3);
});

test('reads an async source lazily and passes every result through', async () => {
  const pulled: number[] = [];
  async function* source() { for (let i = 1; i <= 10; i += 1) { pulled.push(i); yield i; } }
  const results = await collect(mapInOrder(source(), 4, async (n) => n * 2));
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.deepEqual(pulled, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a rejection surfaces at its position and does not leak as unhandled', async () => {
  const seen: number[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const fn = async (n: number) => { if (n === 2) throw new Error('boom'); return n; };
    await assert.rejects((async () => { for await (const v of mapInOrder([1, 2, 3, 4], 2, fn)) seen.push(v); })(), /boom/);
    assert.deepEqual(seen, [1]);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
