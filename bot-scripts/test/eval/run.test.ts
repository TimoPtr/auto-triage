import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.ts';
import { openDatabase } from '../../src/store/db.ts';
import { runEval, summaryMarkdown } from '../../src/eval/run.ts';
import type { EvalCase } from '../../src/eval/cases.ts';
import type { IndexItem, SourceKind } from '../../src/providers/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-run-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const vectorFor = (text: string) => {
  const t = text.toLowerCase();
  if (t.includes('widget')) return Float32Array.from([1, 0, 0, 0]);
  if (t.includes('notification')) return Float32Array.from([0, 1, 0, 0]);
  return Float32Array.from([0, 0, 1, 0]);
};
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts: string[]) { return texts.map(vectorFor); } };

const item = (source: SourceKind, sourceId: string, title: string, text: string, createdAt: string, url: string, extra: { comment?: { text: string; createdAt: string }; heading?: string } = {}): IndexItem => ({
  source, provider: source === 'docs' ? 'github' : 'github', origin: source === 'docs' ? 'o/docs' : 'o/r', sourceId, url, title, audience: 'user',
  createdAt, updatedAt: null, outcome: null, extra: null,
  chunks: [
    { seq: 0, kind: source === 'docs' ? 'section' : 'body', heading: extra.heading ?? null, anchor: extra.heading?.toLowerCase() ?? null, text, logs: null, createdAt, authorRole: source === 'docs' ? null : 'reporter' },
    ...(extra.comment ? [{ seq: 1, kind: 'comment' as const, heading: null, anchor: null, text: extra.comment.text, logs: null, createdAt: extra.comment.createdAt, authorRole: 'maintainer' as const }] : []),
  ],
});

const indexPath = join(tmp, 'knowledge.sqlite');
test.before(async () => {
  async function* items() {
    yield item('issue', '1', 'Widget stops after reboot', 'Widget stops after reboot', '2025-03-01T00:00:00Z', 'https://github.com/o/r/issues/1');
    yield item('issue', '2', 'Widget stops too', 'Widget stops too', '2025-05-01T00:00:00Z', 'https://github.com/o/r/issues/2', { comment: { text: 'duplicate of #1', createdAt: '2025-05-02T00:00:00Z' } });
    yield item('issue', '3', 'Notification sound missing', 'Notification sound missing', '2025-04-01T00:00:00Z', 'https://github.com/o/r/issues/3');
    yield item('docs', 'widgets', 'Android Widgets', 'Widgets refresh on tap', '1970-01-01T00:00:00Z', 'https://docs.example/docs/widgets', { heading: 'Refresh' });
    yield item('pull', '9', 'fix widget', 'fix widget', '2025-06-01T00:00:00Z', 'https://github.com/o/r/pull/9');
  }
  await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} });
});

const base = { split: 'test' as const, expectedTier: 'high' as const, labelSource: 'test', verified: false };
const cases: EvalCase[] = [
  { ...base, id: 'dup-2', relation: 'duplicate', query: { type: 'issue', number: 2, origin: 'o/r', asOf: '2025-05-02T12:00:00Z' }, expected: [{ type: 'issue', number: 1, origin: 'o/r' }] },
  { ...base, id: 'docs-2', relation: 'docs', query: { type: 'issue', number: 2, asOf: '2025-05-02T12:00:00Z' }, expected: [{ type: 'docs', url: 'https://docs.example/docs/widgets#refresh' }] },
  { ...base, id: 'fix-3', relation: 'fixed-by', query: { type: 'issue', number: 3, asOf: '2025-06-02T00:00:00Z' }, expected: [{ type: 'pull', number: 9 }] },
  { ...base, id: 'neg-3', relation: 'negative', query: { type: 'issue', number: 3, asOf: '2025-04-01T00:00:00Z' }, expected: [] },
  { ...base, id: 'missing-1', relation: 'duplicate', query: { type: 'issue', number: 1 }, expected: [{ type: 'issue', number: 404 }] },
  { ...base, id: 'text-1', relation: 'curated', query: { type: 'text', text: 'widget stops' }, expected: [{ type: 'docs', url: 'https://docs.example/docs/widgets/' }] },
];

async function run(subset: EvalCase[], options: Partial<Parameters<typeof runEval>[0]> = {}) {
  const db = openDatabase(indexPath, { readOnly: true });
  try {
    return await runEval({ db, embedder, cases: subset, threshold: 0.5, ...options });
  } finally {
    db.close();
  }
}

test('scores hits, errors and the gate', async () => {
  const { results, errors, summary } = await run(cases);
  assert.deepEqual(results.map((r) => r.id), ['dup-2', 'docs-2', 'fix-3', 'neg-3', 'text-1']);
  assert.deepEqual(errors, [{ id: 'missing-1', reason: 'expected not in index: issue 404' }]);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['dup-2'].firstRank, 1);
  assert.ok(byId['dup-2'].ranked.every((r) => !(r.source === 'issue' && r.sourceId === '2')), 'the query item never ranks');
  assert.ok(byId['docs-2'].firstRank !== null && byId['docs-2'].firstRank <= 5, 'docs hit by url');
  assert.ok(byId['text-1'].firstRank !== null);
  assert.equal(byId['neg-3'].positive, false);
  assert.equal(byId['neg-3'].firstRank, null);
  assert.equal(summary.run.cases, 6);
  assert.equal(summary.run.scored, 5);
  assert.equal(summary.run.errors, 1);
  assert.equal(summary.run.mode, 'production');
  assert.equal(summary.run.modelKey, 'fake@1@q8@cls');
  assert.equal(summary.retrieval.all.n, 4);
  assert.equal(summary.retrieval.byRelation.duplicate.recallAt5, 100);
  assert.ok(summary.retrieval.byExpectedSource.docs.n === 2);
  assert.equal(summary.gate.at.threshold, 0.5);
  assert.equal(summary.gate.at.negatives, 1);
  assert.equal(summary.gate.sweep.length, 14);
});

test('excludes the query item and chunks after asOf', async () => {
  const { results } = await run([{ ...base, id: 'early-1', relation: 'duplicate', query: { type: 'issue', number: 1, asOf: '2025-04-01T00:00:00Z' }, expected: [{ type: 'issue', number: 2 }] }]);
  assert.equal(results[0].firstRank, null);
  assert.ok(results[0].ranked.every((r) => !(r.source === 'issue' && (r.sourceId === '1' || r.sourceId === '2'))));
});

test('reports an expected item missing from the index as an error', async () => {
  const { results, errors } = await run([
    { ...base, id: 'gone-docs', relation: 'docs', query: { type: 'issue', number: 2 }, expected: [{ type: 'docs', url: 'https://docs.example/docs/renamed' }] },
    { ...base, id: 'gone-query', relation: 'docs', query: { type: 'issue', number: 77 }, expected: [{ type: 'docs', url: 'https://docs.example/docs/widgets' }] },
  ]);
  assert.deepEqual(results, []);
  assert.deepEqual(errors, [{ id: 'gone-docs', reason: 'expected not in index: docs https://docs.example/docs/renamed' }, { id: 'gone-query', reason: 'query item not in index: issue 77' }]);
});

test('oracle mode finds every expected at rank 1 and skips negatives', async () => {
  const { results, summary } = await run(cases.filter((c) => c.id !== 'missing-1'), { mode: 'oracle' });
  assert.deepEqual(results.map((r) => r.id), ['dup-2', 'docs-2', 'fix-3', 'text-1']);
  assert.ok(results.every((r) => r.firstRank === 1), JSON.stringify(results.map((r) => [r.id, r.firstRank])));
  assert.equal(summary.retrieval.all.recallAt5, 100);
  assert.equal(summary.run.mode, 'oracle');
});

test('null mode ranks random items and is deterministic', async () => {
  const first = await run(cases.filter((c) => c.id !== 'missing-1'), { mode: 'null', seed: 1 });
  const again = await run(cases.filter((c) => c.id !== 'missing-1'), { mode: 'null', seed: 1 });
  assert.deepEqual(first.results, again.results);
  assert.equal(first.summary.run.mode, 'null');
  assert.ok(first.results.every((r) => r.bestSimilarity === 0 && r.ranked.length > 0));
  assert.ok(first.results.every((r) => r.ranked.every((e) => !(e.source === 'issue' && e.sourceId === String((cases.find((c) => c.id === r.id)!.query as { number?: number }).number)))), 'the query item is not drawn');
});

test('summary markdown lists relations and the gate line', async () => {
  const { summary } = await run(cases);
  const md = summaryMarkdown(summary);
  assert.match(md, /\| duplicate \| 1 \| 100\.0 \|/);
  assert.match(md, /gate at 0\.50/i);
  assert.match(md, /\| 0\.30 \|/);
  assert.match(md, /errors: 1/);
});

test('ages candidates as of the case date, not today', async () => {
  // issue 1 is 62 days old at this asOf; decayed only if the harness let retrieve use the real clock
  const query: EvalCase[] = [{ ...base, id: 'aged', relation: 'curated', query: { type: 'text', text: 'widget stops', asOf: '2025-05-02T12:00:00Z' }, expected: [{ type: 'issue', number: 1 }] }];
  const decayed = await run(query, { retrieveOptions: { decayAfterDays: 365, decayFactor: 0.5 } });
  const plain = await run(query, { retrieveOptions: { decayAfterDays: 365, decayFactor: 1 } });
  const fusedOf = (r: typeof decayed) => r.results[0].ranked.find((e) => e.source === 'issue' && e.sourceId === '1')!.fused;
  assert.equal(fusedOf(decayed), fusedOf(plain));
});
