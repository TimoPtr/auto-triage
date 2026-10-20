import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFeedback, parseSuggested, suppressedOf } from '../../src/feedback/collect.ts';
import { fakeRaw } from './fake-raw.ts';
import type { RawRecord } from '../../src/store/raw.ts';

const marker = (run: string, tier: string, issue: number) => `<!-- knowledge-bot v1 run=${run} tier=${tier} issue=${issue} -->`;
const botBody = (run: string, tier: string, issue: number, suggested: number[]) =>
  `${marker(run, tier, issue)}\n\n**Possibly related to earlier reports**\n${suggested.map((n) => `- #${n} Earlier report ${n} (closed, Jan 2025)`).join('\n')}\n\n**Discussions and docs**\n- #8 Not a duplicate\n\n---\nWas this helpful?`;
const bot = (id: number, run: string, tier: string, issue: number, at: string, suggested: number[], reactions: Record<string, number> = {}) =>
  ({ id, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: at, body: botBody(run, tier, issue, suggested), reactions: { '+1': 0, '-1': 0, ...reactions } });
const human = (id: number, login: string, association: string, at: string, body: string) => ({ id, user: { login }, author_association: association, created_at: at, body, reactions: { '+1': 0, '-1': 0 } });

const issueRecord = (number: number, issue: Record<string, unknown>, comments: unknown[]): RawRecord => ({
  provider: 'github', origin: 'o/r', kind: 'issue', id: String(number), updatedAt: '2026-10-15T00:00:00Z',
  payload: { issue: { number, title: `Issue ${number}`, state: 'open', html_url: `https://github.com/o/r/issues/${number}`, user: { login: 'alice' }, comments: comments.length, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z', ...issue }, comments, complete: true },
});

const raw = fakeRaw([
  issueRecord(10, { state: 'closed', state_reason: 'duplicate', closed_at: '2026-10-12T00:00:00Z', closed_by: { login: 'maintainer1' } }, [
    bot(501, '1', 'high', 10, '2026-10-10T00:00:00Z', [5, 7], { '+1': 2 }),
    human(502, 'maintainer1', 'MEMBER', '2026-10-11T00:00:00Z', 'Yes this is #7, closing.'),
  ]),
  { provider: 'github', origin: 'o/r', kind: 'links', id: '10', updatedAt: '2026-10-15T00:00:00Z', payload: { version: 2, kind: 'issue', duplicateOf: [7], duplicatedBy: [], closes: [], markedAt: '2026-10-12T00:00:00Z' } },
  issueRecord(11, { state: 'closed', state_reason: 'completed', closed_at: '2026-10-12T00:00:00Z', closed_by: { login: 'alice' } }, [
    bot(511, '1', 'medium', 11, '2026-10-10T00:00:00Z', [5], { '-1': 1 }),
  ]),
  issueRecord(12, {}, [
    bot(521, '2', 'medium', 12, '2026-10-10T00:00:00Z', []),
    human(522, 'bob', 'NONE', '2026-10-10T12:00:00Z', 'Still happens for me'),
    bot(523, '3', 'low', 12, '2026-10-11T00:00:00Z', []),
  ]),
  issueRecord(13, {}, [
    human(531, 'carol', 'NONE', '2026-10-10T00:00:00Z', `> ${marker('9', 'high', 13)}\n> quoted bot text\n\nI disagree`),
    human(532, 'dave', 'NONE', '2026-10-10T01:00:00Z', `Look at this ${marker('9', 'high', 13)} pasted marker`),
  ]),
  issueRecord(14, { state: 'closed', state_reason: 'duplicate', closed_at: '2026-10-13T00:00:00Z', closed_by: { login: 'maintainer1' } }, [
    bot(541, '4', 'high', 14, '2026-10-10T00:00:00Z', [5]),
    human(542, 'maintainer1', 'MEMBER', '2026-10-13T00:00:00Z', 'Duplicate of #99'),
  ]),
  issueRecord(15, {}, [human(551, 'erin', 'NONE', '2026-10-10T00:00:00Z', 'plain issue comment')]),
  issueRecord(16, { state: 'closed', state_reason: 'duplicate', closed_at: '2026-10-13T00:00:00Z', closed_by: { login: 'maintainer1' } }, [
    bot(561, '5', 'high', 16, '2026-10-10T00:00:00Z', [5]),
  ]),
  issueRecord(17, { state: 'closed', state_reason: 'duplicate', closed_at: '2026-10-13T00:00:00Z', closed_by: { login: 'maintainer1' }, updated_at: '2026-10-13T00:00:00Z' }, [
    bot(571, '6', 'high', 17, '2026-10-10T00:00:00Z', [5]),
    human(572, 'maintainer1', 'MEMBER', '2026-10-13T00:00:00Z', 'Duplicate of #5'),
  ]),
  { provider: 'github', origin: 'o/r', kind: 'links', id: '17', updatedAt: '2026-10-01T00:00:00Z', payload: { version: 2, kind: 'issue', duplicateOf: [], duplicatedBy: [], closes: [], markedAt: null } },
]);
const now = new Date('2026-10-20T00:00:00Z');

test('parses the suggested duplicates from the bot comment', () => {
  assert.deepEqual(parseSuggested(botBody('1', 'high', 10, [5, 7])), [5, 7]);
  assert.deepEqual(parseSuggested('no sections'), []);
  assert.deepEqual(parseSuggested(`${marker('1', 'medium', 3)}\n\n**Discussions and docs**\n- #8 Only related\n`), []);
});

test('collects reactions, the reply and a duplicate hit', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  assert.equal(f.version, 1); assert.equal(f.repository, 'o/r'); assert.equal(f.generatedAt, now.toISOString());
  const c = f.comments.find((x) => x.issue === 10);
  assert.deepEqual({ up: c.up, down: c.down, suggested: c.suggested, tier: c.tier, runId: c.runId, commentId: c.commentId, commentAt: c.commentAt },
    { up: 2, down: 0, suggested: [5, 7], tier: 'high', runId: '1', commentId: 501, commentAt: '2026-10-10T00:00:00Z' });
  assert.deepEqual(c.reply, { role: 'maintainer', at: '2026-10-11T00:00:00Z', text: 'Yes this is #7, closing.' });
  assert.deepEqual(c.outcome, { recheck: false, closedAt: '2026-10-12T00:00:00Z', stateReason: 'duplicate', duplicateOf: [7], hit: true, miss: false, answered: false, dismissed: false });
});

test('marks a downvoted comment and a reporter close as answered and suppresses it', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  const c = f.comments.find((x) => x.issue === 11);
  assert.equal(c.down, 1); assert.equal(c.reply, null);
  assert.deepEqual(c.outcome, { recheck: false, closedAt: '2026-10-12T00:00:00Z', stateReason: 'completed', duplicateOf: [], hit: false, miss: false, answered: true, dismissed: true });
  assert.deepEqual(f.suppressed.filter((s) => s.issue === 11), [{ issue: 11, reason: 'downvoted', at: '2026-10-10T00:00:00Z' }]);
});

test('marks a recheck and a miss from a maintainer duplicate comment', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  const twelve = f.comments.filter((x) => x.issue === 12).sort((a, b) => a.commentAt.localeCompare(b.commentAt));
  assert.equal(twelve.length, 2);
  assert.equal(twelve[0].outcome.recheck, true); assert.equal(twelve[0].reply.role, 'user'); assert.equal(twelve[0].reply.text, 'Still happens for me');
  assert.equal(twelve[1].outcome.recheck, false); assert.equal(twelve[1].reply, null);
  const fourteen = f.comments.find((x) => x.issue === 14);
  assert.deepEqual(fourteen.outcome, { recheck: false, closedAt: '2026-10-13T00:00:00Z', stateReason: 'duplicate', duplicateOf: [99], hit: false, miss: true, answered: false, dismissed: true });
  assert.deepEqual(f.suppressed.filter((s) => s.issue === 14), [{ issue: 14, reason: 'dismissed', at: '2026-10-10T00:00:00Z' }]);
  assert.ok(f.suppressed.every((s) => s.issue !== 10 && s.issue !== 12));
});

test('recognises bot comments only by a leading marker', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  assert.ok(f.comments.every((c) => c.issue !== 13 && c.issue !== 15));
  assert.equal(f.comments.length, 7);
  assert.deepEqual(f.comments.map((c) => c.commentAt), [...f.comments.map((c) => c.commentAt)].sort().reverse(), 'newest first');
});

test('suppressedOf keeps one entry per issue, latest comment first', () => {
  const base = { runId: '1', tier: 'high', commentId: null, suggested: [], up: 0, reply: null, outcome: { recheck: false, closedAt: null, stateReason: null, duplicateOf: [], hit: false, miss: false, answered: false, dismissed: false } };
  const list = suppressedOf([
    { ...base, issue: 3, commentAt: '2026-10-02T00:00:00Z', down: 1 },
    { ...base, issue: 3, commentAt: '2026-10-01T00:00:00Z', down: 0, outcome: { ...base.outcome, dismissed: true } },
    { ...base, issue: 4, commentAt: '2026-10-01T00:00:00Z', down: 0 },
  ]);
  assert.deepEqual(list, [{ issue: 3, reason: 'downvoted', at: '2026-10-02T00:00:00Z' }]);
});

test('ignores markers posted by humans or with an unknown tier', () => {
  const spoofed = fakeRaw([
    issueRecord(20, {}, [
      { ...bot(601, '1', 'high', 20, '2026-10-10T00:00:00Z', [5]), user: { login: 'mallory', type: 'User' } },
      bot(602, '2', 'evil|tier', 20, '2026-10-11T00:00:00Z', [5]),
      bot(603, 'abc', 'high', 20, '2026-10-12T00:00:00Z', [5]),
      bot(604, '3', 'medium', 20, '2026-10-13T00:00:00Z', [5]),
    ]),
  ]);
  const f = collectFeedback({ raw: spoofed, repository: 'o/r', now });
  assert.deepEqual(f.comments.map((c) => c.commentId), [604]);
});

test('an unknown duplicate target is neither a hit nor a miss', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  const c = f.comments.find((x) => x.issue === 16);
  assert.deepEqual({ ...c.outcome }, { recheck: false, closedAt: '2026-10-13T00:00:00Z', stateReason: 'duplicate', duplicateOf: [], hit: false, miss: false, answered: false, dismissed: false });
  assert.ok(f.suppressed.every((s) => s.issue !== 16));
});

test('falls through to maintainer comments when the links record is empty or stale', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  const c = f.comments.find((x) => x.issue === 17);
  assert.deepEqual(c.outcome.duplicateOf, [5]);
  assert.equal(c.outcome.hit, true);
});

test('a clean latest comment lifts the suppression of an issue', () => {
  const base = { runId: '1', tier: 'high', commentId: null, suggested: [], up: 0, reply: null, outcome: { recheck: false, closedAt: null, stateReason: null, duplicateOf: [], hit: false, miss: false, answered: false, dismissed: false } };
  const list = suppressedOf([
    { ...base, issue: 3, commentAt: '2026-10-02T00:00:00Z', down: 0 },
    { ...base, issue: 3, commentAt: '2026-10-01T00:00:00Z', down: 1 },
  ]);
  assert.deepEqual(list, []);
});
