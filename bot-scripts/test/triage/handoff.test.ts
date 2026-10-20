import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toExcerpt, validateHandoff, HandoffError, EXCERPT_MAX_CHARS, type Handoff } from '../../src/triage/handoff.ts';
import type { RetrievalResult } from '../../src/retrieval/retrieve.ts';

const result = (over: Partial<RetrievalResult> = {}): RetrievalResult => ({
  itemId: 1, chunkId: 1, source: 'issue', provider: 'github', origin: 'o/r', sourceId: '5610', url: 'https://github.com/o/r/issues/5610',
  title: 'Widget stops updating after reboot', heading: null, anchor: null, text: 'Widget stops updating after reboot', createdAt: '2025-01-12T10:00:00Z',
  audience: 'user', authorRole: 'reporter', outcome: { state: 'closed', stateReason: 'completed' },
  scores: { similarity: 0.71, itemSimilarity: 0.8, lexical: 12.4, fused: 0.031 }, rank: 1, ...over,
});

export const sampleHandoff = (): Handoff => ({
  version: 1, product: { name: 'Android', slug: 'android' }, repository: 'o/r',
  issue: { number: 7612, title: 'Widget frozen', body: 'Widget frozen after reboot', logs: null, labels: [], createdAt: '2026-10-20T00:00:00Z' },
  excerpts: [toExcerpt(result(), 0, ['#5644'])],
  thresholds: { answer: 75, links: 45 },
  retrieval: { bestSimilarity: 0.8, minSimilarity: 0.35, indexBuiltAt: '2026-10-19T03:00:00Z' },
});

test('maps a retrieval result to an excerpt with the outcome of its source', () => {
  const issue = toExcerpt(result(), 0, ['#5644']);
  assert.deepEqual(issue.outcome, { state: 'closed', reason: 'completed', fixedBy: ['#5644'], solved: null });
  assert.equal(issue.id, 0); assert.equal(issue.date, '2025-01-12'); assert.equal(issue.scores.similarity, 0.8);
  assert.equal(toExcerpt(result({ source: 'docs', outcome: null }), 1, []).outcome, null);
  assert.deepEqual(toExcerpt(result({ source: 'forum', outcome: { solved: true } }), 2, []).outcome, { state: null, reason: null, fixedBy: [], solved: true });
  assert.deepEqual(toExcerpt(result({ source: 'pull', outcome: { state: 'merged' } }), 3, ['#1']).outcome, { state: 'merged', reason: null, fixedBy: [], solved: null });
  assert.equal(toExcerpt(result({ text: 'x'.repeat(2000) }), 4, []).text.length, EXCERPT_MAX_CHARS);
});

test('validates a built handoff and rejects one that does not match the schema', () => {
  const handoff = sampleHandoff();
  assert.equal(validateHandoff(JSON.parse(JSON.stringify(handoff))).issue.number, 7612);
  assert.throws(() => validateHandoff({ ...handoff, excerpts: [{ ...handoff.excerpts[0], url: null }] }), (e) => e instanceof HandoffError && /url/.test(e.message));
  assert.throws(() => validateHandoff({ ...handoff, version: 2 }), HandoffError);
  assert.throws(() => validateHandoff({ ...handoff, extra: 1 }), HandoffError);
});
