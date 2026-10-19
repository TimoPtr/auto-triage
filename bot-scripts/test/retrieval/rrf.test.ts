import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuse } from '../../src/retrieval/rrf.ts';

test('an id present in both lists outranks one present in a single list', () => {
  const scores = fuse([{ weight: 1, ids: [1, 2, 3] }, { weight: 1, ids: [3, 4] }], { k: 60 });
  assert.ok(scores.get(3) > scores.get(1));
  assert.ok(scores.get(1) > scores.get(4));
});

test('weights scale a list contribution and bigint ids normalize to numbers', () => {
  const scores = fuse([{ weight: 0.5, ids: [1n] }, { weight: 1, ids: [2n] }]);
  assert.ok(scores.get(2) > scores.get(1));
  assert.equal(scores.has(1n as unknown as number), false);
});

test('ids with equal scores share a rank instead of taking arbitrary consecutive ranks', () => {
  const scores = fuse([{ weight: 1, ids: [1, 2, 3], scores: [0.5, 0.5, 0.9] }], { k: 60 });
  assert.equal(scores.get(1), scores.get(2));
  assert.equal(scores.get(3), 1 / 63);
});
