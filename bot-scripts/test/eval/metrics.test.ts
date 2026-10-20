import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalMetrics, byGroup, gateAt, gateSweep, compareRuns, type CaseResult } from '../../src/eval/metrics.ts';
import { mulberry32 } from '../../src/eval/random.ts';

const result = (id: string, firstRank: number | null, bestSimilarity: number, positive = true, expectedSources = ['issue']): CaseResult => ({
  id, relation: positive ? 'duplicate' : 'negative', split: 'test', expectedSources, ranked: [], firstRank, bestSimilarity, positive,
});

test('recall and mrr over positives only', () => {
  const m = retrievalMetrics([result('a', 1, 0.9), result('b', 7, 0.8), result('c', null, 0.2), result('n', 1, 0.9, false)]);
  assert.equal(m.n, 3);
  assert.equal(m.recallAt5.toFixed(1), '33.3');
  assert.equal(m.mrr.toFixed(4), ((1 + 1 / 7) / 3).toFixed(4));
  assert.deepEqual(retrievalMetrics([result('n', 1, 0.9, false)]), { n: 0, recallAt5: 0, mrr: 0 });
});

test('groups a result under every expected source', () => {
  const groups = byGroup([result('a', 1, 0.9, true, ['issue', 'docs']), result('b', null, 0.1, true, ['docs'])], (r) => r.expectedSources);
  assert.deepEqual(Object.keys(groups).sort(), ['docs', 'issue']);
  assert.equal(groups.issue.n, 1);
  assert.equal(groups.docs.n, 2);
  assert.equal(groups.docs.recallAt5, 50);
});

test('gate precision and specificity at a threshold', () => {
  const results = [result('p1', 1, 0.8), result('p2', 1, 0.4), result('n1', null, 0.6, false), result('n2', null, 0.2, false)];
  const g = gateAt(results, 0.5);
  assert.deepEqual(g, { threshold: 0.5, precision: 50, specificity: 50, sensitivity: 50, positives: 2, negatives: 2 });
});

test('gate returns null without negatives', () => {
  const g = gateAt([result('p1', 1, 0.8)], 0.9);
  assert.equal(g.specificity, null);
  assert.equal(g.precision, null, 'nothing commented');
  assert.equal(g.sensitivity, 0);
});

test('sweep covers 0.30 to 0.95', () => {
  const sweep = gateSweep([result('p1', 1, 0.8), result('n1', null, 0.2, false)]);
  assert.equal(sweep.length, 14);
  assert.equal(sweep[0].threshold, 0.3);
  assert.equal(sweep[13].threshold, 0.95);
  assert.equal(sweep[0].specificity, 100);
});

test('compare reports a regression with a confidence interval excluding zero', () => {
  const a = Array.from({ length: 40 }, (_, i) => result(`c${i}`, 1, 0.9));
  const b = Array.from({ length: 40 }, (_, i) => result(`c${i}`, i < 20 ? 1 : null, 0.9));
  const c = compareRuns(a, [...b, result('only-in-b', 1, 0.9)]);
  assert.equal(c.n, 40);
  assert.equal(c.deltaRecallAt5, -50);
  assert.ok(c.ci95[1] < 0 && c.ci95[0] <= c.ci95[1], JSON.stringify(c));
  assert.equal(c.regression, true);
  const same = compareRuns(a, a);
  assert.equal(same.deltaRecallAt5, 0);
  assert.equal(same.regression, false);
});

test('compare is deterministic for a seed', () => {
  const a = Array.from({ length: 30 }, (_, i) => result(`c${i}`, i % 3 === 0 ? null : 1, 0.9));
  const b = Array.from({ length: 30 }, (_, i) => result(`c${i}`, i % 2 === 0 ? null : 1, 0.9));
  assert.deepEqual(compareRuns(a, b, { seed: 7 }), compareRuns(a, b, { seed: 7 }));
  const rng = mulberry32(1);
  const first = [rng(), rng()];
  const again = mulberry32(1);
  assert.deepEqual([again(), again()], first);
  assert.ok(first.every((x) => x >= 0 && x < 1));
});
