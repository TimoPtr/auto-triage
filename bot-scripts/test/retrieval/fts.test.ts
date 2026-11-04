import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFtsQuery } from '../../src/retrieval/fts.ts';

test('quotes tokens as prefixes, strips trailing punctuation and joins them with OR', () => {
  assert.equal(toFtsQuery('Widget not updating: binary_sensor.motion_detected!'), '"widget"* OR "not"* OR "updating"* OR "binary_sensor.motion_detected"*');
});

test('returns null for a question without indexable tokens', () => {
  assert.equal(toFtsQuery('?? !! a'), null);
});

test('never emits unbalanced quotes', () => {
  assert.equal(toFtsQuery('say "hi" there'), '"say"* OR "hi"* OR "there"*');
});

test('keeps only the first 128 distinct tokens of a long question', () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
  const query = toFtsQuery(`${words.join(' ')} ${words.join(' ')}`);
  assert.ok(query !== null);
  const terms = query.split(' OR ');
  assert.equal(terms.length, 128);
  assert.equal(terms[0], '"word0"*');
  assert.equal(terms[127], '"word127"*');
});
