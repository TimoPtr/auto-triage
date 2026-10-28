import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toExcerpt, validateHandoff, HandoffError, EXCERPT_MAX_CHARS } from '../../src/triage/handoff.ts';
import { result, sampleHandoff } from './fixtures.ts';

test('maps a retrieval result to an excerpt with the outcome of its source', () => {
  const issue = toExcerpt(result(), 0, ['#5644']);
  assert.deepEqual(issue.outcome, { state: 'closed', reason: 'completed', fixedBy: ['#5644'], solved: null });
  assert.equal(issue.id, 0); assert.equal(issue.date, '2025-01-12'); assert.equal(issue.scores.similarity, 0.8);
  assert.equal(toExcerpt(result({ source: 'docs', outcome: null }), 1, []).outcome, null);
  assert.deepEqual(toExcerpt(result({ source: 'forum', outcome: { solved: true } }), 2, []).outcome, { state: null, reason: null, fixedBy: [], solved: true });
  assert.deepEqual(toExcerpt(result({ source: 'pull', outcome: { state: 'merged' } }), 3, ['#1']).outcome, { state: 'merged', reason: null, fixedBy: [], solved: null });
  assert.deepEqual(toExcerpt(result({ source: 'pull', outcome: { state: 'closed' } }), 5, []).outcome, { state: 'closed', reason: 'not merged', fixedBy: [], solved: null });
  assert.equal(toExcerpt(result({ text: 'x'.repeat(2000) }), 4, []).text.length, EXCERPT_MAX_CHARS);
});

test('validates a built handoff and rejects one that does not match the schema', () => {
  const handoff = sampleHandoff();
  assert.equal(validateHandoff(JSON.parse(JSON.stringify(handoff))).issue.number, 7612);
  assert.throws(() => validateHandoff({ ...handoff, excerpts: [{ ...handoff.excerpts[0], url: null }] }), (e) => e instanceof HandoffError && /url/.test(e.message));
  assert.throws(() => validateHandoff({ ...handoff, version: 2 }), HandoffError);
  assert.throws(() => validateHandoff({ ...handoff, extra: 1 }), HandoffError);
});
