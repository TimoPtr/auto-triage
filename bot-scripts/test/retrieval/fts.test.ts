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
