import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat } from '../../src/index/stream.ts';
import type { Provider, ProviderItem } from '../../src/providers/types.ts';

const item = (n: number): ProviderItem => ({ source: 'issue', provider: 'github', origin: 'o/r', sourceId: String(n), url: 'u', title: 't', audience: 'user', createdAt: '2025-01-01T00:00:00Z', chunks: [] });

test('logs a progress line per minute while a provider lists, then the total', async () => {
  let clock = 0;
  const provider: Provider = { name: 'github issues o/r', async *items() { for (let i = 1; i <= 5; i += 1) { clock += 25_000; yield item(i); } } };
  const lines: string[] = [];
  let count = 0;
  for await (const _ of concat([provider], (l) => lines.push(l), {}, { now: () => clock })) count += 1;
  assert.equal(count, 5);
  // one line at 75 s; the next would be due at 135 s, after the provider ended
  assert.deepEqual(lines, [
    'github issues o/r: 3 items so far, 75.0s elapsed',
    'github issues o/r: 5 items in 125.0s',
  ]);
});
