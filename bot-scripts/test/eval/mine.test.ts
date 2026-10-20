import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineCases, sampleMarkdown } from '../../src/eval/mine.ts';
import { openRawStore, type RawStore } from '../../src/store/raw.ts';
import type { Config } from '../../src/config/types.ts';
import type { EvalCase } from '../../src/eval/cases.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-mine-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const REPO = 'o/r';
const config: Config = {
  version: 1, product: { name: 'P', slug: 'p' },
  providers: {
    github: {
      [REPO]: { issues: { states: ['open', 'closed'], comments: true }, pulls: { states: ['merged', 'closed'], reviews: true, excludeBots: true } },
      'o/docs': { docs: { path: 'docs', baseUrl: 'https://docs.example/docs/', audience: 'user' } },
    },
    discourse: { 'forum.example': { categories: ['c'], tags: [], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 4 } },
  },
  embedding: { model: 'm', revision: 'r', dtype: 'q8', dimensions: 4, pooling: 'cls' }, peers: [],
};

interface CommentSpec { body: string; createdAt: string; association?: string }
interface IssueSpec { state?: 'open' | 'closed'; createdAt: string; closedAt?: string | null; comments?: CommentSpec[]; complete?: boolean }
function store(name: string) {
  const raw = openRawStore(join(tmp, `${name}.sqlite`));
  const issue = (number: number, { state = 'closed', createdAt, closedAt = null, comments = [], complete = true }: IssueSpec) => raw.put({
    provider: 'github', origin: REPO, kind: 'issue', id: String(number), updatedAt: createdAt,
    payload: {
      issue: { number, title: `Issue ${number}`, state, html_url: `https://github.com/o/r/issues/${number}`, user: { login: 'rep' }, comments: comments.length, created_at: createdAt, updated_at: createdAt, closed_at: closedAt, body: 'body' },
      comments: comments.map((c) => ({ user: { login: 'm' }, author_association: c.association ?? 'MEMBER', created_at: c.createdAt, body: c.body })),
      complete,
    },
  });
  const pull = (number: number, { body, mergedAt, createdAt = '2025-01-01T00:00:00Z' }: { body: string; mergedAt: string | null; createdAt?: string }) => raw.put({
    provider: 'github', origin: REPO, kind: 'pull', id: String(number), updatedAt: createdAt,
    payload: { pull: { number, title: `PR ${number}`, state: 'closed', merged_at: mergedAt, closed_at: mergedAt, html_url: `https://github.com/o/r/pull/${number}`, user: { login: 'dev' }, created_at: createdAt, updated_at: createdAt, draft: false, body }, reviewComments: [], files: [], complete: true },
  });
  const topic = (id: number) => raw.put({ provider: 'discourse', origin: 'forum.example', kind: 'topic', id: String(id), updatedAt: 'x', payload: { listed: { id }, topic: {} } });
  const links = (number: number, { kind = 'issue', duplicateOf = [], closes = [], markedAt = null }: { kind?: 'issue' | 'pull'; duplicateOf?: number[]; closes?: number[]; markedAt?: string | null }) => raw.put({
    provider: 'github', origin: REPO, kind: 'links', id: String(number), updatedAt: 'x', payload: { kind, duplicateOf, closes, markedAt },
  });
  return { raw, issue, pull, topic, links };
}
const byId = (cases: EvalCase[]): Record<string, EvalCase> => Object.fromEntries(cases.map((c) => [c.id, c]));

test('labels a timeline duplicate with the later issue as query', () => {
  const s = store('timeline');
  s.issue(10, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-05T00:00:00Z' });
  s.issue(20, { createdAt: '2025-02-01T00:00:00Z', closedAt: '2025-02-02T00:00:00Z' });
  s.links(20, { duplicateOf: [10], markedAt: '2025-02-02T00:00:00Z' });
  const { cases, report } = mineCases({ config, raw: s.raw });
  const dup = byId(cases)['dup-20'];
  assert.ok(dup, JSON.stringify(cases));
  assert.deepEqual(dup.query, { type: 'issue', number: 20, origin: REPO, asOf: '2025-02-02T00:00:00Z' });
  assert.deepEqual(dup.expected, [{ type: 'issue', number: 10, origin: REPO }]);
  assert.equal(dup.labelSource, 'timeline:marked-duplicate');
  assert.equal(dup.expectedTier, 'high');
  assert.equal(dup.verified, false);
  assert.equal(report.counts.byRelation.duplicate, 1);
  s.raw.close();
});

test('orders a comment duplicate by creation', () => {
  const s = store('comment');
  s.issue(5, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-03-02T00:00:00Z', comments: [{ body: 'Duplicate of #30, closing.', createdAt: '2025-03-02T00:00:00Z' }] });
  s.issue(30, { createdAt: '2025-03-01T00:00:00Z', closedAt: null, state: 'open' });
  const { cases } = mineCases({ config, raw: s.raw });
  const dup = byId(cases)['dup-30'];
  assert.ok(dup, JSON.stringify(cases));
  assert.deepEqual(dup.expected, [{ type: 'issue', number: 5, origin: REPO }]);
  assert.equal(dup.query.asOf, '2025-03-02T00:00:00Z');
  assert.equal(dup.labelSource, 'comment:duplicate-of');
  assert.equal(byId(cases)['dup-5'], undefined);
  s.raw.close();
});

test('ignores duplicate claims from non-maintainers', () => {
  const s = store('nonmaintainer');
  s.issue(10, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-05T00:00:00Z' });
  s.issue(20, { createdAt: '2025-02-01T00:00:00Z', closedAt: '2025-02-02T00:00:00Z', comments: [{ body: 'duplicate of #10', createdAt: '2025-02-02T00:00:00Z', association: 'NONE' }] });
  const { cases } = mineCases({ config, raw: s.raw });
  assert.deepEqual(cases.filter((c) => c.relation === 'duplicate'), []);
  s.raw.close();
});

test('prefers the timeline over the comment', () => {
  const s = store('prefer');
  s.issue(10, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-05T00:00:00Z' });
  s.issue(11, { createdAt: '2025-01-02T00:00:00Z', closedAt: '2025-01-05T00:00:00Z' });
  s.issue(20, { createdAt: '2025-02-01T00:00:00Z', closedAt: '2025-02-02T00:00:00Z', comments: [{ body: 'dupe of #11', createdAt: '2025-02-02T00:00:00Z' }] });
  s.links(20, { duplicateOf: [10], markedAt: '2025-02-03T00:00:00Z' });
  const { cases } = mineCases({ config, raw: s.raw });
  const dups = cases.filter((c) => c.relation === 'duplicate');
  assert.equal(dups.length, 1);
  assert.equal(dups[0].labelSource, 'timeline:marked-duplicate');
  assert.deepEqual(dups[0].expected, [{ type: 'issue', number: 10, origin: REPO }]);
  s.raw.close();
});

test('labels fixed-by from closing references and from the body', () => {
  const s = store('fixed');
  s.issue(1, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-10T00:00:00Z' });
  s.issue(2, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-11T00:00:00Z' });
  s.issue(3, { createdAt: '2025-01-01T00:00:00Z', closedAt: null, state: 'open' });
  s.pull(40, { body: 'Fixes #1', mergedAt: '2025-01-10T00:00:00Z' });
  s.links(40, { kind: 'pull', closes: [1] });
  s.pull(41, { body: 'Closes #2 and resolves #3', mergedAt: '2025-01-11T00:00:00Z' });
  s.pull(42, { body: 'Fixes #2', mergedAt: null });
  const { cases } = mineCases({ config, raw: s.raw });
  const fixes = byId(cases);
  assert.deepEqual(fixes['fix-1'].expected, [{ type: 'pull', number: 40, origin: REPO }]);
  assert.equal(fixes['fix-1'].labelSource, 'pull:closing-reference');
  assert.equal(fixes['fix-1'].query.asOf, '2025-01-10T00:00:00Z');
  assert.deepEqual(fixes['fix-2'].expected, [{ type: 'pull', number: 41, origin: REPO }]);
  assert.equal(fixes['fix-2'].labelSource, 'pull:body-keyword');
  assert.equal(fixes['fix-2'].expectedTier, 'medium');
  assert.equal(fixes['fix-3'], undefined, 'an open issue is not fixed');
  s.raw.close();
});

test('labels docs and forum answers from maintainer comments before the close', () => {
  const s = store('answers');
  s.topic(777);
  s.issue(1, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-03T00:00:00Z', comments: [
    { body: 'See https://docs.example/docs/notifications/commands/#tts and https://docs.example/docs/widgets?x=1', createdAt: '2025-01-02T00:00:00Z' },
    { body: 'Also https://docs.example/docs/late', createdAt: '2025-01-05T00:00:00Z' },
    { body: 'Discussed at https://forum.example/t/widget-slug/777 and https://forum.example/t/888', createdAt: '2025-01-02T12:00:00Z' },
  ] });
  s.issue(2, { createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-03T00:00:00Z', comments: [{ body: 'https://docs.example/docs/x', createdAt: '2025-01-02T00:00:00Z', association: 'CONTRIBUTOR' }] });
  const { cases, report } = mineCases({ config, raw: s.raw });
  const c = byId(cases);
  assert.deepEqual(c['docs-1'].expected, [{ type: 'docs', url: 'https://docs.example/docs/notifications/commands' }, { type: 'docs', url: 'https://docs.example/docs/widgets' }]);
  assert.equal(c['docs-1'].query.asOf, '2025-01-02T00:00:00Z');
  assert.equal(c['docs-1'].labelSource, 'comment:docs-link');
  assert.deepEqual(c['forum-1'].expected, [{ type: 'forum', number: 777, origin: 'forum.example' }]);
  assert.equal(c['forum-1'].query.asOf, '2025-01-02T12:00:00Z');
  assert.equal(c['forum-1'].expectedTier, 'medium');
  assert.equal(c['docs-2'], undefined);
  assert.equal(report.dropped['unknown-target'], 1);
  s.raw.close();
});

test('draws as many negatives as known-answer positives, deterministically', () => {
  const s = store('negatives');
  for (const n of [1, 2, 3, 4]) { s.issue(n, { createdAt: `2025-01-0${n}T00:00:00Z`, closedAt: '2025-02-01T00:00:00Z' }); s.pull(40 + n, { body: `fixes #${n}`, mergedAt: '2025-02-01T00:00:00Z' }); }
  s.issue(10, { createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-02-01T00:00:00Z' });
  s.issue(20, { createdAt: '2025-03-01T00:00:00Z', closedAt: '2025-03-02T00:00:00Z', comments: [{ body: 'duplicate of #10', createdAt: '2025-03-02T00:00:00Z' }] });
  s.issue(21, { createdAt: '2025-03-01T00:00:00Z', closedAt: '2025-03-02T00:00:00Z', comments: [{ body: 'https://docs.example/docs/a', createdAt: '2025-03-02T00:00:00Z' }] });
  const first = mineCases({ config, raw: s.raw });
  const negatives = first.cases.filter((c) => c.relation === 'negative');
  assert.equal(negatives.length, 2);
  assert.equal(first.report.negativesPool, 4);
  assert.deepEqual(negatives[0].expected, []);
  assert.equal(negatives[0].expectedTier, 'low');
  assert.equal(negatives[0].query.asOf, (negatives[0].query as { number: number }).number === 1 ? '2025-01-01T00:00:00Z' : negatives[0].query.asOf);
  const second = mineCases({ config, raw: s.raw });
  assert.deepEqual(second.cases.filter((c) => c.relation === 'negative').map((c) => c.id), negatives.map((c) => c.id));
  const salted = ['a', 'b', 'c', 'd', 'e'].map((salt) => mineCases({ config, raw: s.raw, salt }).cases.filter((c) => c.relation === 'negative').map((c) => c.id).join());
  assert.ok(new Set(salted).size > 1, 'a salt can change the draw');
  s.raw.close();
});

test('drops unknown targets and counts them', () => {
  const s = store('unknown');
  s.issue(20, { createdAt: '2025-02-01T00:00:00Z', closedAt: '2025-02-02T00:00:00Z', comments: [{ body: 'duplicate of https://github.com/other/repo/issues/10', createdAt: '2025-02-02T00:00:00Z' }] });
  s.issue(21, { createdAt: '2025-02-01T00:00:00Z', closedAt: '2025-02-02T00:00:00Z', comments: [{ body: 'duplicate of #999', createdAt: '2025-02-02T00:00:00Z' }] });
  s.issue(22, { createdAt: '2025-02-01T00:00:00Z', closedAt: '2025-02-02T00:00:00Z', complete: false, comments: [{ body: 'duplicate of #20', createdAt: '2025-02-02T00:00:00Z' }] });
  const { cases, report } = mineCases({ config, raw: s.raw });
  assert.deepEqual(cases, []);
  assert.equal(report.dropped['unknown-target'], 2);
  assert.equal(report.dropped['incomplete-issue'], 1);
  s.raw.close();
});

test('sample markdown lists n cases in hash order with links and an empty verdict', () => {
  const cases = Array.from({ length: 5 }, (_, i) => ({ id: `dup-${i}`, relation: 'duplicate' as const, split: 'train' as const, query: { type: 'issue' as const, number: i, origin: REPO }, expected: [{ type: 'issue' as const, number: 100 + i, origin: REPO }], expectedTier: 'high' as const, labelSource: 'x', verified: false }));
  const md = sampleMarkdown(cases, 3, '', (c) => ({ query: `https://github.com/o/r/issues/${(c.query as { number: number }).number}`, expected: c.expected.map((e) => `https://github.com/o/r/issues/${e.number}`) }));
  const rows = md.split('\n').filter((l) => l.startsWith('| dup-'));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /\| dup-\d \| duplicate \| x \| https:\/\/github\.com\/o\/r\/issues\/\d \| https:\/\/github\.com\/o\/r\/issues\/10\d \|\s*\|$/);
  assert.notDeepEqual(rows, md.split('\n').filter((l) => l.startsWith('| dup-')).sort());
});
